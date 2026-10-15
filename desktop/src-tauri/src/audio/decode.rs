use std::fs::File;
use std::io::{BufReader, Cursor};
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
use crate::audio::loudness::{LoudnessAnalysis, measure};
use crate::audio::types::{ChannelCount, EqParams, SampleRate};

const NORMALIZATION_CACHE_VERSION: u8 = 4;

pub fn is_ogg_opus(bytes: &[u8]) -> bool {
    // OpusHead appears at byte 28 in a standard OGG Opus header page
    bytes.len() >= 36
        && &bytes[0..4] == b"OggS"
        && bytes[..bytes.len().min(64)]
            .windows(8)
            .any(|w| w == b"OpusHead")
}

/// `is_ogg_opus` for a reader: peeks at the first 64 bytes without loading the
/// file. The caller's reader is left wherever the peek ended — decode paths
/// always re-open the source anyway.
pub(crate) fn is_ogg_opus_reader<R: std::io::Read>(reader: &mut R) -> bool {
    let mut buf = [0u8; 64];
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return false,
        }
    }
    is_ogg_opus(&buf[..filled])
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
    pub(crate) fn from_reader(reader: R) -> Result<Self, String> {
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
    let lufs = parts.next()?.parse::<f64>().ok()?;
    Some(LoudnessAnalysis { peak, lufs })
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
            analysis.peak, analysis.lufs
        ),
    );
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
        measure(
            OpusSource::new(bytes.to_vec()).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    } else {
        match Decoder::new(Cursor::new(bytes.to_vec())) {
            Ok(source) => measure(source),
            _ => measure(
                OpusSource::new(bytes.to_vec())
                    .map_err(|e| format!("Failed to decode: {}", e))?,
            ),
        }
    };

    write_cached_analysis(cache_dir, cache_key, analysis);
    Ok(analysis)
}

/// `resolve_loudness_analysis` for a file source: decodes the analysis window
/// straight off disk instead of first loading the whole file into memory.
pub fn resolve_loudness_analysis_file(
    path: &Path,
    cache_dir: Option<&Path>,
    cache_key: Option<&str>,
) -> Result<LoudnessAnalysis, String> {
    if let Some(analysis) = read_cached_analysis(cache_dir, cache_key) {
        return Ok(analysis);
    }

    let open_file = || {
        File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))
    };
    let is_opus = is_ogg_opus_reader(&mut open_file()?);

    let analysis = if is_opus {
        measure(
            OpusSource::from_reader(open_file()?).map_err(|e| format!("Failed to decode: {}", e))?,
        )
    } else {
        match open_file().and_then(|file| {
            Decoder::try_from(file).map_err(|e| format!("Failed to decode: {}", e))
        }) {
            Ok(source) => measure(source),
            _ => measure(
                OpusSource::from_reader(open_file()?).map_err(|e| format!("Failed to decode: {}", e))?,
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
                "[audio] resampling {} Hz → {} Hz",
                source.sample_rate(),
                rate
            );
            player.append(ResampleSource::new(source, rate));
        }
        _ => player.append(source),
    }
}

/// Wrap `source` into the shared DSP chain (gain → EQ → analyser → volume) and
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
fn create_player_from_reader<R, F, D>(
    make_reader: F,
    make_decoder: D,
    is_opus: bool,
    mixer: &Mixer,
    volume: f32,
    volume_handle: Option<Arc<std::sync::atomic::AtomicU32>>,
    normalization_gain: f32,
    start_paused: bool,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
    output_sample_rate: u32,
) -> Result<(Player, Option<f64>), String>
where
    R: std::io::Read + std::io::Seek + Send + Sync + 'static,
    F: Fn() -> Result<R, String>,
    D: Fn(R) -> Result<Decoder<R>, String>,
{
    let player = Player::connect_new(mixer);
    if volume_handle.is_none() {
        player.set_volume(volume);
    }
    if start_paused {
        player.pause();
    }

    let duration;
    if is_opus {
        let source =
            OpusSource::from_reader(make_reader()?).map_err(|e| format!("Failed to decode: {}", e))?;
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
        match make_decoder(make_reader()?) {
            Ok(source) => {
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
            Err(_) => {
                let source = OpusSource::from_reader(make_reader()?)
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
            }
        }
    }

    Ok((player, duration))
}

/// Player from an in-memory payload. The buffer is shared through an `Arc`, so
/// the decoder's cursor and any re-open clone only the handle, never the bytes.
#[allow(clippy::too_many_arguments)]
pub fn create_player_from_arc_bytes(
    bytes: Arc<Vec<u8>>,
    mixer: &Mixer,
    volume: f32,
    volume_handle: Option<Arc<std::sync::atomic::AtomicU32>>,
    normalization_gain: f32,
    start_paused: bool,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
    output_sample_rate: u32,
) -> Result<(Player, Option<f64>), String> {
    let is_opus = is_ogg_opus(&bytes);
    let arc = crate::audio::state::ArcBytes(bytes);
    create_player_from_reader(
        move || Ok(Cursor::new(arc.clone())),
        |reader| Decoder::new(reader).map_err(|e| format!("Failed to decode: {}", e)),
        is_opus,
        mixer,
        volume,
        volume_handle,
        normalization_gain,
        start_paused,
        eq_params,
        analyser_buffer,
        output_sample_rate,
    )
}

/// Player from a cached file: the decoder streams off disk, so a full track is
/// never buffered in RAM (the whole point for WAV caches).
#[allow(clippy::too_many_arguments)]
pub fn create_player_from_file(
    path: &Path,
    mixer: &Mixer,
    volume: f32,
    volume_handle: Option<Arc<std::sync::atomic::AtomicU32>>,
    normalization_gain: f32,
    start_paused: bool,
    eq_params: Arc<RwLock<EqParams>>,
    analyser_buffer: Arc<AnalyserBuffer>,
    output_sample_rate: u32,
) -> Result<(Player, Option<f64>), String> {
    let is_opus = {
        let mut probe =
            File::open(path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
        is_ogg_opus_reader(&mut probe)
    };
    // Feed the decoder the file length: symphonia then knows the byte length
    // (accurate seeking + duration for MP3s).
    let byte_len = std::fs::metadata(path).map(|meta| meta.len()).ok();
    let path = path.to_path_buf();
    create_player_from_reader(
        move || {
            File::open(&path)
                .map(BufReader::new)
                .map_err(|e| format!("Failed to open {}: {}", path.display(), e))
        },
        move |reader| {
            let mut builder = Decoder::<BufReader<File>>::builder()
                .with_data(reader)
                .with_seekable(true);
            if let Some(len) = byte_len {
                builder = builder.with_byte_len(len);
            }
            builder
                .build()
                .map_err(|e| format!("Failed to decode: {}", e))
        },
        is_opus,
        mixer,
        volume,
        volume_handle,
        normalization_gain,
        start_paused,
        eq_params,
        analyser_buffer,
        output_sample_rate,
    )
}

