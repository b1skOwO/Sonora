use std::io::Cursor;
use std::num::NonZero;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use rodio::mixer::Mixer;
use rodio::source::SeekError;
use rodio::{Decoder, Player, Source};
use sha2::{Digest, Sha256};

use crate::audio::analyser::{AnalyserBuffer, AnalyserSource};
use crate::audio::eq::{EqSource, GainSource, VolumeSource};
use crate::audio::resample::ResampleSource;
use crate::audio::types::{
    ChannelCount, EqParams, SampleRate, NORMALIZATION_ANALYSIS_SAMPLES,
    NORMALIZATION_BLOCK_SAMPLES, NORMALIZATION_MAX_ATTENUATION_DB, NORMALIZATION_MAX_BOOST_DB,
    NORMALIZATION_SAFETY_PEAK, NORMALIZATION_TARGET_PEAK, NORMALIZATION_TARGET_RMS,
};

const NORMALIZATION_CACHE_VERSION: u8 = 3;

pub fn is_ogg_opus(bytes: &[u8]) -> bool {
    // OpusHead appears at byte 28 in a standard OGG Opus header page
    bytes.len() >= 36
        && &bytes[0..4] == b"OggS"
        && bytes[..bytes.len().min(64)]
            .windows(8)
            .any(|w| w == b"OpusHead")
}

pub(crate) struct OpusSource<R: std::io::Read + std::io::Seek> {
    reader: ogg::reading::PacketReader<R>,
    decoder: audiopus::coder::Decoder,
    channels: ChannelCount,
    buffer: Vec<f32>,
    buf_pos: usize,
    serial: u32,
    pre_skip: usize,
    samples_skipped: usize,
}

impl OpusSource<Cursor<Vec<u8>>> {
    pub(crate) fn new(data: Vec<u8>) -> Result<Self, String> {
        Self::from_reader(Cursor::new(data))
    }
}

impl<R: std::io::Read + std::io::Seek> OpusSource<R> {
    fn from_reader(reader: R) -> Result<Self, String> {
        let mut reader = ogg::reading::PacketReader::new(reader);

        let head_pkt = reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?
            .ok_or("No OpusHead packet")?;

        let head = &head_pkt.data;
        if head.len() < 19 || &head[..8] != b"OpusHead" {
            return Err("Invalid OpusHead".into());
        }

        let serial = head_pkt.stream_serial();
        let ch_count = head[9];
        let pre_skip = u16::from_le_bytes([head[10], head[11]]) as usize;
        let opus_ch = if ch_count == 1 {
            audiopus::Channels::Mono
        } else {
            audiopus::Channels::Stereo
        };

        reader
            .read_packet()
            .map_err(|e| format!("OGG read error: {}", e))?;

        let decoder = audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch)
            .map_err(|e| format!("Opus decoder error: {:?}", e))?;

        let channel_count = if ch_count == 1 { 1u16 } else { 2u16 };

        Ok(Self {
            reader,
            decoder,
            channels: NonZero::new(channel_count).unwrap(),
            buffer: Vec::new(),
            buf_pos: 0,
            serial,
            pre_skip: pre_skip * channel_count as usize,
            samples_skipped: 0,
        })
    }

    fn decode_next_packet(&mut self) -> bool {
        loop {
            match self.reader.read_packet() {
                Ok(Some(pkt)) => {
                    if pkt.data.is_empty() {
                        continue;
                    }
                    let channels = self.channels.get() as usize;
                    let mut buf = vec![0f32; 5760 * channels];
                    match self.decoder.decode_float(Some(&pkt.data), &mut buf, false) {
                        Ok(samples_per_ch) => {
                            let total = samples_per_ch * channels;
                            buf.truncate(total);

                            if self.samples_skipped < self.pre_skip {
                                let skip = (self.pre_skip - self.samples_skipped).min(total);
                                self.samples_skipped += skip;
                                if skip >= total {
                                    continue;
                                }
                                self.buffer = buf[skip..].to_vec();
                            } else {
                                self.buffer = buf;
                            }
                            self.buf_pos = 0;
                            return true;
                        }
                        Err(_) => continue,
                    }
                }
                _ => return false,
            }
        }
    }
}

impl<R: std::io::Read + std::io::Seek> Iterator for OpusSource<R> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.buf_pos >= self.buffer.len() && !self.decode_next_packet() {
            return None;
        }
        let sample = self.buffer[self.buf_pos];
        self.buf_pos += 1;
        Some(sample)
    }
}

impl<R: std::io::Read + std::io::Seek> Source for OpusSource<R> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        NonZero::new(48000).unwrap()
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        let target_gp = (pos.as_secs_f64() * 48000.0) as u64;

        match self.reader.seek_absgp(Some(self.serial), target_gp) {
            Ok(_) => {
                let opus_ch = if self.channels.get() == 1 {
                    audiopus::Channels::Mono
                } else {
                    audiopus::Channels::Stereo
                };
                self.decoder =
                    audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, opus_ch).map_err(
                        |_| SeekError::NotSupported {
                            underlying_source: "opus decoder reinit failed",
                        },
                    )?;
                self.buffer.clear();
                self.buf_pos = 0;
                self.samples_skipped = self.pre_skip;
                Ok(())
            }
            Err(_) => Err(SeekError::NotSupported {
                underlying_source: "ogg seek failed",
            }),
        }
    }
}

fn normalization_cache_file(cache_dir: &Path, cache_key: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(cache_key.as_bytes());
    let hash = hex::encode(hasher.finalize());
    cache_dir.join(format!("{hash}.gain"))
}

/// Peak + gated RMS of the analysis window 遯ｶ繝ｻthe numbers the loudness and
/// safety gains are derived from.
#[derive(Clone, Copy, Debug)]
pub struct LoudnessAnalysis {
    pub peak: f64,
    pub rms: f64,
}

fn read_cached_analysis(
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Option<LoudnessAnalysis> {
    let path = normalization_cache_file(cache_dir?, cache_key?);
    let raw = std::fs::read_to_string(path).ok()?;
    let mut parts = raw.trim().split(':');
    if parts.next()? != NORMALIZATION_CACHE_VERSION.to_string() {
        return None;
    }
    let peak = parts.next()?.parse::<f64>().ok()?;
    let rms = parts.next()?.parse::<f64>().ok()?;
    Some(LoudnessAnalysis { peak, rms })
}

fn write_cached_analysis(
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
    analysis: LoudnessAnalysis,
) {
    let Some(cache_dir) = cache_dir else {
        return;
    };
    let Some(cache_key) = cache_key else {
        return;
    };

    if std::fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    let path = normalization_cache_file(cache_dir, cache_key);
    let _ = std::fs::write(
        path,
        format!(
            "{NORMALIZATION_CACHE_VERSION}:{:.6}:{:.6}",
            analysis.peak, analysis.rms
        ),
    );
}

fn analyze_samples<I>(samples: I) -> LoudnessAnalysis
where
    I: IntoIterator<Item = f32>,
{
    let mut peak = 0.0f64;
    let mut count = 0usize;
    let mut block_sum_sq = 0.0f64;
    let mut block_count = 0usize;
    let mut block_powers = Vec::new();

    for sample in samples.into_iter().take(NORMALIZATION_ANALYSIS_SAMPLES) {
        let value = sample as f64;
        peak = peak.max(value.abs());
        block_sum_sq += value * value;
        block_count += 1;
        count += 1;

        if block_count >= NORMALIZATION_BLOCK_SAMPLES {
            block_powers.push(block_sum_sq / block_count as f64);
            block_sum_sq = 0.0;
            block_count = 0;
        }
    }

    if block_count > 0 {
        block_powers.push(block_sum_sq / block_count as f64);
    }

    if count == 0 || block_powers.is_empty() {
        return LoudnessAnalysis { peak: 0.0, rms: 1.0 };
    }

    // Gate out the quietest 40% of blocks so silence/intros don't skew the RMS.
    block_powers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep_from = ((block_powers.len() as f64) * 0.4).floor() as usize;
    let kept = &block_powers[keep_from.min(block_powers.len().saturating_sub(1))..];
    let gated_power = kept.iter().copied().sum::<f64>() / kept.len() as f64;

    LoudnessAnalysis {
        peak,
        rms: gated_power.sqrt().max(1e-6),
    }
}

/// Loudness gain for the user's normalization setting: brings the gated RMS to
/// the target, capped so peaks stay under the target peak; clamped to
/// [-8, +9] dB and snapped to unity when it lands close to it.
pub fn loudness_gain(analysis: LoudnessAnalysis, peak: f64) -> f32 {
    let peak = peak.max(1e-6);
    let target_gain = NORMALIZATION_TARGET_RMS / analysis.rms;
    let peak_safe_gain = NORMALIZATION_TARGET_PEAK / peak;
    let max_boost = 10f64.powf(NORMALIZATION_MAX_BOOST_DB / 20.0);
    let max_attenuation = 10f64.powf(NORMALIZATION_MAX_ATTENUATION_DB / 20.0);
    let gain = target_gain
        .min(peak_safe_gain)
        .clamp(max_attenuation, max_boost);

    if (gain - 1.0).abs() < 0.05 {
        1.0
    } else {
        gain as f32
    }
}

/// Always-on peak safety: attenuation-only gain that keeps decoded samples
/// (which overshoot full scale by up to several dB in lossy sources) from hard
/// clipping at the output. Applied regardless of the normalization setting 遯ｶ繝ｻ
/// it is a static gain, so dynamics are untouched.
pub fn peak_safety_gain(peak: f64) -> f32 {
    (NORMALIZATION_SAFETY_PEAK / peak.max(1e-6)).min(1.0) as f32
}

pub fn resolve_loudness_analysis(
    bytes: &[u8],
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Result<LoudnessAnalysis, String> {
    if let Some(analysis) = read_cached_analysis(cache_dir, cache_key) {
        return Ok(analysis);
    }

    let analysis = if is_ogg_opus(bytes) {
        analyze_samples(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    } else {
        match Decoder::new(Cursor::new(bytes.to_vec())) {
            Ok(source) => analyze_samples(source),
            _ => analyze_samples(
                OpusSource::new(bytes.to_vec())
                    .map_err(|e| format!("Failed to decode: {}", e))?,
            ),
        }
    };

    write_cached_analysis(cache_dir, cache_key, analysis);
    Ok(analysis)
}

/// Append `source` to `player`, resampling to `output_sample_rate` first when
/// the rates differ, so rodio's mixer never falls back to its linear
/// interpolator (see `resample`).
fn append_final<S>(player: &Player, source: S, output_sample_rate: u32)
where
    S: Source<Item = f32> + Send + 'static,
{
    match NonZero::new(output_sample_rate) {
        Some(rate) if rate != source.sample_rate() => {
            eprintln!(
                "[audio] resampling {} Hz 遶翫・{} Hz",
                source.sample_rate(),
                rate
            );
            player.append(ResampleSource::new(source, rate));
        }
        _ => player.append(source),
    }
}

/// Wrap `source` into the shared DSP chain (gain 遶翫・EQ 遶翫・analyser 遶翫・volume) and
/// append it to the player. With a `volume_handle` the player's own volume stays
/// at 1.0 and the chain applies the live user volume. The chain is resampled to
/// the device rate at the very end, so EQ/analyser keep running at the source
/// rate and the mixer sees a matching rate.
fn append_chain<S>(
    player: &Player,
    source: S,
    normalization_gain: f32,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
    volume_handle: Option<Arc<std::sync::atomic::AtomicU32>>,
    output_sample_rate: u32,
) where
    S: Source<Item = f32> + Send + 'static,
{
    let eq = EqSource::new(GainSource::new(source, normalization_gain), eq_params);
    match volume_handle {
        // Volume sits *outside* the analyser so the visualizer stays
        // volume-independent, exactly as it was with rodio's player volume.
        Some(handle) => append_final(
            player,
            VolumeSource::new(AnalyserSource::new(eq, analyser_buffer), handle),
            output_sample_rate,
        ),
        None => append_final(
            player,
            AnalyserSource::new(eq, analyser_buffer),
            output_sample_rate,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_player_from_bytes(
    bytes: &[u8],
    mixer: &Mixer,
    volume: f32,
    volume_handle: Option<Arc<std::sync::atomic::AtomicU32>>,
    normalization_gain: f32,
    start_paused: bool,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
    output_sample_rate: u32,
) -> Result<(Player, Option<f64>), String> {
    let player = Player::connect_new(mixer);
    if volume_handle.is_none() {
        player.set_volume(volume);
    }
    if start_paused {
        player.pause();
    }

    let duration;
    if is_ogg_opus(bytes) {
        let source =
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?;
        duration = source.total_duration().map(|d| d.as_secs_f64());
        append_chain(
            &player,
            source,
            normalization_gain,
            eq_params,
            analyser_buffer,
            volume_handle,
            output_sample_rate,
        );
    } else if Decoder::new(Cursor::new(bytes.to_vec())).is_ok() {
        let source = Decoder::new(Cursor::new(bytes.to_vec()))
            .map_err(|e| format!("Failed to decode: {}", e))?;
        duration = source.total_duration().map(|d| d.as_secs_f64());
        append_chain(
            &player,
            source,
            normalization_gain,
            eq_params,
            analyser_buffer,
            volume_handle,
            output_sample_rate,
        );
    } else {
        let source =
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?;
        duration = source.total_duration().map(|d| d.as_secs_f64());
        append_chain(
            &player,
            source,
            normalization_gain,
            eq_params,
            analyser_buffer,
            volume_handle,
            output_sample_rate,
        );
    }

    Ok((player, duration))
}



#[cfg(test)]
mod tests {
    use super::{loudness_gain, peak_safety_gain, LoudnessAnalysis};

    fn analysis(peak: f64, rms: f64) -> LoudnessAnalysis {
        LoudnessAnalysis { peak, rms }
    }

    #[test]
    fn safety_is_attenuation_only_with_headroom() {
        // Hot master: capped so the peak lands at the -2 dB safety ceiling,
        // leaving room for resampler overshoot and true-peak excursion.
        let hot = peak_safety_gain(3.0);
        assert!((hot - (0.79 / 3.0) as f32).abs() < 1e-6, "got {hot}");
        // Material already under the ceiling: untouched.
        assert_eq!(peak_safety_gain(0.79), 1.0);
        assert_eq!(peak_safety_gain(0.5), 1.0);
    }

    #[test]
    fn loudness_targets_rms_but_respects_the_peak() {
        // Right on the RMS target with headroom to spare: unity.
        assert_eq!(loudness_gain(analysis(0.5, 0.14), 0.5), 1.0);
        // Loud master: the -8 dB attenuation floor binds, not the RMS target.
        let floored = loudness_gain(analysis(2.0, 0.5), 2.0);
        let floor = 10f64.powf(-8.0 / 20.0) as f32;
        assert!((floored - floor).abs() < 1e-6, "got {floored}");
        // RMS target above unity is still capped by the peak ceiling.
        let capped = loudness_gain(analysis(2.0, 0.07), 2.0);
        let peak_cap = (0.95 / 2.0) as f32;
        assert!((capped - peak_cap).abs() < 1e-4, "got {capped}");
    }
}
