//! GET `/download/:urn` → JSON-список кандидатов SoundCloud. Тянем выбранного
//! напрямую с SC, наш сервер только резолвит ссылки.
//!
//! Порядок: при `hq=true` сначала hq-группа, иначе sq. Внутри группы — по
//! пресету (aac_160k → abr_sq → …), HLS раньше progressive (как в веб-плеере
//! SC), encrypted-hls последним.

use std::future::Future;
use std::pin::Pin;

use base64::Engine as _;
use bytes::Bytes;
use futures_util::future::select_all;
use wreq::Client;

use super::sc_anon::hls::{download_hls_full, download_progressive};
use super::state::PlaybackQuality;

#[derive(serde::Deserialize)]
pub struct DownloadResponse {
    pub candidates: Vec<Candidate>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Candidate {
    Progressive {
        #[serde(default = "default_sq")]
        quality: String,
        #[serde(default)]
        preset: String,
        url: String,
    },
    Hls {
        #[serde(default = "default_sq")]
        quality: String,
        #[serde(default)]
        preset: String,
        manifest_url: String,
    },
    EncryptedHls {
        #[serde(default = "default_sq")]
        quality: String,
        #[serde(default)]
        preset: String,
        init_base64: String,
        segments: Vec<String>,
        key_base64: String,
    },
}

fn default_sq() -> String {
    "sq".to_string()
}

impl Candidate {
    fn quality(&self) -> &str {
        match self {
            Candidate::Progressive { quality, .. } => quality,
            Candidate::Hls { quality, .. } => quality,
            Candidate::EncryptedHls { quality, .. } => quality,
        }
    }

    fn preset(&self) -> &str {
        match self {
            Candidate::Progressive { preset, .. } => preset,
            Candidate::Hls { preset, .. } => preset,
            Candidate::EncryptedHls { preset, .. } => preset,
        }
    }

    fn kind_label(&self) -> &'static str {
        match self {
            Candidate::Progressive { .. } => "progressive",
            Candidate::Hls { .. } => "hls",
            Candidate::EncryptedHls { .. } => "encrypted-hls",
        }
    }

    fn kind_score(&self) -> u32 {
        match self {
            Candidate::Hls { .. } => 0,
            Candidate::Progressive { .. } => 1,
            Candidate::EncryptedHls { .. } => 2,
        }
    }

    fn playback_quality(&self) -> PlaybackQuality {
        if self.quality() == "hq" {
            PlaybackQuality::Hq
        } else {
            PlaybackQuality::Sq
        }
    }
}

pub struct DirectResult {
    pub data: Bytes,
    pub quality: PlaybackQuality,
}

pub async fn try_download(
    client: &Client,
    download_urls: &[String],
    session_id: Option<&str>,
    hq_pref: bool,
) -> Option<DirectResult> {
    if download_urls.is_empty() {
        return None;
    }

    let mut futures: Vec<Pin<Box<dyn Future<Output = Option<DirectResult>> + Send>>> =
        download_urls
            .iter()
            .map(|url| {
                let client = client.clone();
                let endpoint = url.clone();
                let session_id = session_id.map(str::to_string);
                Box::pin(async move {
                    try_one_endpoint(&client, &endpoint, session_id.as_deref(), hq_pref).await
                }) as Pin<Box<dyn Future<Output = Option<DirectResult>> + Send>>
            })
            .collect();

    while !futures.is_empty() {
        let (result, _idx, remaining) = select_all(futures).await;
        if result.is_some() {
            return result;
        }
        futures = remaining;
    }
    None
}

async fn try_one_endpoint(
    client: &Client,
    endpoint: &str,
    session_id: Option<&str>,
    hq_pref: bool,
) -> Option<DirectResult> {
    let resp = match fetch_download(client, endpoint, session_id).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[direct] {endpoint} failed: {e}");
            return None;
        }
    };
    let sorted = sort_candidates(resp.candidates, hq_pref);
    if sorted.is_empty() {
        println!("[direct] {endpoint} returned no usable candidates");
    } else {
        let listing = sorted
            .iter()
            .map(|c| format!("{}/{}/{}", c.kind_label(), c.quality(), c.preset()))
            .collect::<Vec<_>>()
            .join(", ");
        println!("[direct] {endpoint} candidates: [{listing}]");
    }
    for cand in sorted {
        let q = cand.playback_quality();
        match consume(client, &cand).await {
            Ok(data) => {
                println!(
                    "[direct] hit {} ({} {})",
                    cand.kind_label(),
                    cand.quality(),
                    cand.preset()
                );
                return Some(DirectResult { data, quality: q });
            }
            Err(e) => {
                eprintln!(
                    "[direct] {} {} {} failed: {e}",
                    cand.kind_label(),
                    cand.quality(),
                    cand.preset()
                );
            }
        }
    }
    None
}

async fn fetch_download(
    client: &Client,
    endpoint: &str,
    session_id: Option<&str>,
) -> Result<DownloadResponse, String> {
    let (resp, hop) = crate::network::audio_route::get(client, endpoint, session_id)
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    println!("[direct] endpoint via {}", hop.tier_label());
    resp.json::<DownloadResponse>()
        .await
        .map_err(|e| format!("decode: {e}"))
}

/// Quality rank of a preset name — lower is better. Mirrors the anon path and
/// the SoundCloud web player: HLS AAC 160k first, legacy progressive MP3 last.
fn preset_score(preset: &str) -> u32 {
    match preset {
        "aac_160k" => 0,
        "abr_sq" => 1,
        "opus_0_0" => 2,
        "aac_96k" => 3,
        "mp3_1_0" => 5,
        _ => 4,
    }
}

fn sort_candidates(cands: Vec<Candidate>, hq_pref: bool) -> Vec<Candidate> {
    let mut filtered: Vec<Candidate> = cands.into_iter().filter(|c| c.quality() != "lq").collect();
    filtered.sort_by_key(|c| {
        let is_hq = c.quality() == "hq";
        let q_score = if hq_pref == is_hq { 0u32 } else { 1u32 };
        (q_score, preset_score(c.preset()), c.kind_score())
    });
    filtered
}

async fn consume(client: &Client, cand: &Candidate) -> Result<Bytes, String> {
    match cand {
        Candidate::Progressive { url, .. } => download_progressive(client, url).await,
        Candidate::Hls { manifest_url, .. } => download_hls_full(client, manifest_url).await,
        Candidate::EncryptedHls {
            init_base64,
            segments,
            key_base64,
            ..
        } => consume_encrypted(client, init_base64, segments, key_base64).await,
    }
}

async fn consume_encrypted(
    client: &Client,
    init_b64: &str,
    segments: &[String],
    key_b64: &str,
) -> Result<Bytes, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let init = b64.decode(init_b64).map_err(|e| format!("init: {e}"))?;
    let key_bytes = b64.decode(key_b64).map_err(|e| format!("key: {e}"))?;
    if key_bytes.len() != 16 {
        return Err(format!("key length {}", key_bytes.len()));
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&key_bytes);

    let mut buf = Vec::with_capacity(init.len());
    buf.extend_from_slice(&init);

    for url in segments {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("seg request: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("seg HTTP {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("seg body: {e}"))?;
        let plain = decrypt_client::decrypt_segment(&bytes, &key).map_err(|e| format!("{e}"))?;
        buf.extend_from_slice(&plain);
    }
    Ok(Bytes::from(buf))
}

#[cfg(test)]
mod tests {
    use super::{sort_candidates, Candidate};

    fn hls(preset: &str, quality: &str) -> Candidate {
        Candidate::Hls {
            quality: quality.into(),
            preset: preset.into(),
            manifest_url: "https://x/manifest.m3u8".into(),
        }
    }

    fn progressive(preset: &str, quality: &str) -> Candidate {
        Candidate::Progressive {
            quality: quality.into(),
            preset: preset.into(),
            url: "https://x/progressive".into(),
        }
    }

    #[test]
    fn prefers_hls_aac_over_progressive_mp3() {
        let sorted = sort_candidates(
            vec![
                progressive("mp3_1_0", "sq"),
                hls("aac_96k", "sq"),
                hls("aac_160k", "sq"),
            ],
            false,
        );
        let order: Vec<&str> = sorted.iter().map(|c| c.preset()).collect();
        assert_eq!(order, vec!["aac_160k", "aac_96k", "mp3_1_0"]);
    }

    #[test]
    fn requested_quality_group_wins() {
        let sorted = sort_candidates(
            vec![hls("aac_160k", "sq"), progressive("mp3_1_0", "hq")],
            true,
        );
        assert_eq!(sorted[0].quality(), "hq");
    }

    #[test]
    fn drops_low_quality_candidates() {
        let sorted = sort_candidates(vec![hls("aac_160k", "lq"), hls("aac_96k", "sq")], false);
        assert_eq!(sorted.len(), 1);
        assert_eq!(sorted[0].preset(), "aac_96k");
    }
}
