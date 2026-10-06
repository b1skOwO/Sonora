//! Two-deck DJ mixer riding the shared output mixer.
//!
//! Each deck is an independent rodio `Player` on the same mixer as the main
//! player: it decodes a cached track, applies a DJ FX chain (3-band EQ, DJ
//! filter, flanger), and exposes play/pause, seek, tempo (speed, pitch
//! follows) and an A-B loop. Loading also computes a waveform overview and a
//! rough BPM estimate for beat-matching. The tick thread runs the deck loops,
//! the auto-mix crossfade and emits `dj:tick` for the UI.

use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm1, Hertz, ToHertz, Type, Q_BUTTERWORTH_F64};
use rodio::mixer::Mixer;
use rodio::source::SeekError;
use rodio::{Decoder, Player, Source};
use tauri::{Emitter, State};

use crate::audio::decode::{OpusSource, is_ogg_opus};
use crate::audio::state::AudioState;
use crate::audio::types::{ChannelCount, SampleRate};
use crate::rt::AppHandle;

/// 3-band deck EQ: low shelf, mid bell, high shelf.
const DECK_EQ_FREQS: [f64; 3] = [200.0, 1_000.0, 4_000.0];
const DECK_EQ_Q: f64 = 1.0;
/// Waveform overview resolution (bars).
const PEAK_BUCKETS: usize = 800;
/// Flanger delay range.
const FLANGER_MIN_DELAY_S: f64 = 0.001;
const FLANGER_MAX_DELAY_S: f64 = 0.005;
const FLANGER_LFO_HZ: f64 = 0.25;
const FLANGER_FEEDBACK: f32 = 0.5;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DjDeckTick {
    pub deck: u8,
    pub loaded: bool,
    pub playing: bool,
    pub position: f64,
    pub duration: Option<f64>,
    /// Current crossfader value (the UI follows it during auto-mix).
    pub crossfade: f32,
    pub automix: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DjDeckInfo {
    pub duration_secs: Option<f64>,
    /// Waveform overview, 0.0..1.0 per bar.
    pub peaks: Vec<f32>,
    /// Rough BPM estimate, if the analysis found a plausible tempo.
    pub bpm: Option<f64>,
}

pub struct Deck {
    pub player: Option<Player>,
    /// Decoded source bytes, kept for rebuilding after the source ends.
    pub bytes: Option<Arc<Vec<u8>>>,
    pub duration: Option<f64>,
    pub bpm: Option<f64>,
    /// 0.0..2.0 (multiplied by the crossfader and the app volume).
    pub volume: f32,
    /// 0.5..2.0, pitch follows speed.
    pub speed: f32,
    /// Low / mid / high gains in dB (-12..+12).
    pub eq_gains: [f64; 3],
    pub eq_atoms: Arc<[AtomicU32; 3]>,
    /// DJ filter: -1 = low-pass sweep, 0 = bypass, +1 = high-pass sweep.
    pub filter_atom: Arc<AtomicU32>,
    pub filter_value: f32,
    /// Flanger depth 0.0..1.0 (0 = off).
    pub flanger_atom: Arc<AtomicU32>,
    pub flanger_value: f32,
    /// Loop region in source seconds.
    pub loop_region: Option<(f64, f64)>,
}

impl Deck {
    fn new() -> Self {
        Self {
            player: None,
            bytes: None,
            duration: None,
            bpm: None,
            volume: 0.8,
            speed: 1.0,
            eq_gains: [0.0; 3],
            eq_atoms: Arc::new([
                AtomicU32::new(0f32.to_bits()),
                AtomicU32::new(0f32.to_bits()),
                AtomicU32::new(0f32.to_bits()),
            ]),
            filter_atom: Arc::new(AtomicU32::new(0f32.to_bits())),
            filter_value: 0.0,
            flanger_atom: Arc::new(AtomicU32::new(0f32.to_bits())),
            flanger_value: 0.0,
            loop_region: None,
        }
    }

    fn is_playing(&self) -> bool {
        self.player
            .as_ref()
            .map(|p| !p.is_paused() && !p.empty())
            .unwrap_or(false)
    }
}

struct AutomixRun {
    from: usize,
    started_ms: u64,
    duration_ms: u64,
    from_value: f32,
}

pub struct DjState {
    pub decks: Mutex<[Deck; 2]>,
    /// 0.0 = deck A only, 1.0 = deck B only (equal-power blend).
    pub crossfade: AtomicU32,
    pub active: AtomicBool,
    pub automix: AtomicBool,
    pub automix_run: Mutex<Option<AutomixRun>>,
    /// Auto-mix crossfade length in ms.
    pub automix_fade_ms: AtomicU64,
}

impl DjState {
    pub fn new() -> Self {
        Self {
            decks: Mutex::new([Deck::new(), Deck::new()]),
            crossfade: AtomicU32::new(0f32.to_bits()),
            active: AtomicBool::new(false),
            automix: AtomicBool::new(false),
            automix_run: Mutex::new(None),
            automix_fade_ms: AtomicU64::new(8_000),
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Per-deck FX chain: 3-band EQ, DJ filter and flanger, all driven by shared
/// atomics so the UI can change them live without rebuilding the player.
struct DeckFxSource<S> {
    source: S,
    eq_gains: Arc<[AtomicU32; 3]>,
    filter_atom: Arc<AtomicU32>,
    flanger_atom: Arc<AtomicU32>,
    // EQ
    eq_l: [DirectForm1<f64>; 3],
    eq_r: [DirectForm1<f64>; 3],
    eq_cached: [f64; 3],
    // DJ filter
    filter_l: DirectForm1<f64>,
    filter_r: DirectForm1<f64>,
    filter_kind: i8,
    filter_cutoff: f64,
    // Flanger
    delay_l: VecDeque<f32>,
    delay_r: VecDeque<f32>,
    lfo_phase: f64,
    // Shared
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_channel: u16,
    frame: u64,
}

impl<S: Source<Item = f32>> DeckFxSource<S> {
    fn new(
        source: S,
        eq_gains: Arc<[AtomicU32; 3]>,
        filter_atom: Arc<AtomicU32>,
        flanger_atom: Arc<AtomicU32>,
    ) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let fs: Hertz<f64> = (sample_rate.get() as f64).hz();
        let make_eq = || {
            std::array::from_fn(|i| {
                let filter_type = match i {
                    0 => Type::LowShelf(0.0),
                    2 => Type::HighShelf(0.0),
                    _ => Type::PeakingEQ(0.0),
                };
                let q = if i == 1 { DECK_EQ_Q } else { Q_BUTTERWORTH_F64 };
                let coeffs =
                    Coefficients::<f64>::from_params(filter_type, fs, DECK_EQ_FREQS[i].hz(), q)
                        .unwrap();
                DirectForm1::<f64>::new(coeffs)
            })
        };
        let max_delay = (FLANGER_MAX_DELAY_S * sample_rate.get() as f64).ceil() as usize + 2;

        Self {
            source,
            eq_gains,
            filter_atom,
            flanger_atom,
            eq_l: make_eq(),
            eq_r: make_eq(),
            eq_cached: [0.0; 3],
            filter_l: DirectForm1::<f64>::new(
                Coefficients::<f64>::from_params(
                    Type::LowPass,
                    fs,
                    20_000.0.hz(),
                    Q_BUTTERWORTH_F64,
                )
                .unwrap(),
            ),
            filter_r: DirectForm1::<f64>::new(
                Coefficients::<f64>::from_params(
                    Type::LowPass,
                    fs,
                    20_000.0.hz(),
                    Q_BUTTERWORTH_F64,
                )
                .unwrap(),
            ),
            filter_kind: 0,
            filter_cutoff: 20_000.0,
            delay_l: VecDeque::from(vec![0.0; max_delay]),
            delay_r: VecDeque::from(vec![0.0; max_delay]),
            lfo_phase: 0.0,
            channels,
            sample_rate,
            current_channel: 0,
            frame: 0,
        }
    }

    fn refresh_eq(&mut self) {
        let fs: Hertz<f64> = (self.sample_rate.get() as f64).hz();
        for i in 0..3 {
            let gain = f32::from_bits(self.eq_gains[i].load(Ordering::Relaxed)) as f64;
            if (gain - self.eq_cached[i]).abs() < 0.01 {
                continue;
            }
            let filter_type = match i {
                0 => Type::LowShelf(gain),
                2 => Type::HighShelf(gain),
                _ => Type::PeakingEQ(gain),
            };
            let q = if i == 1 { DECK_EQ_Q } else { Q_BUTTERWORTH_F64 };
            if let Ok(coeffs) =
                Coefficients::<f64>::from_params(filter_type, fs, DECK_EQ_FREQS[i].hz(), q)
            {
                self.eq_l[i] = DirectForm1::<f64>::new(coeffs);
                self.eq_r[i] = DirectForm1::<f64>::new(coeffs);
            }
            self.eq_cached[i] = gain;
        }
    }

    fn refresh_filter(&mut self) {
        let value = f32::from_bits(self.filter_atom.load(Ordering::Relaxed)) as f64;
        let kind = if value < -0.02 {
            -1
        } else if value > 0.02 {
            1
        } else {
            0
        };
        let t = value.abs().clamp(0.0, 1.0);
        let cutoff = 20_000.0 * (20.0f64 / 20_000.0).powf(t);
        if kind == self.filter_kind && (cutoff - self.filter_cutoff).abs() < 5.0 {
            return;
        }
        self.filter_kind = kind;
        self.filter_cutoff = cutoff;
        if kind == 0 {
            return;
        }
        let fs: Hertz<f64> = (self.sample_rate.get() as f64).hz();
        let filter_type = if kind < 0 {
            Type::LowPass
        } else {
            Type::HighPass
        };
        if let Ok(coeffs) =
            Coefficients::<f64>::from_params(filter_type, fs, cutoff.hz(), 0.9)
        {
            self.filter_l = DirectForm1::<f64>::new(coeffs);
            self.filter_r = DirectForm1::<f64>::new(coeffs);
        }
    }
}

impl<S: Source<Item = f32>> Iterator for DeckFxSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        let ch = self.current_channel;
        self.current_channel = (ch + 1) % self.channels.get();
        if ch == 0 {
            self.frame += 1;
        }

        self.refresh_eq();
        self.refresh_filter();

        // EQ
        let mut out = sample as f64;
        let eq = if ch == 0 { &mut self.eq_l } else { &mut self.eq_r };
        for filter in eq.iter_mut() {
            out = Biquad::run(filter, out);
        }

        // DJ filter
        if self.filter_kind != 0 {
            let filter = if ch == 0 {
                &mut self.filter_l
            } else {
                &mut self.filter_r
            };
            out = Biquad::run(filter, out);
        }

        // Flanger
        let depth = f32::from_bits(self.flanger_atom.load(Ordering::Relaxed)).clamp(0.0, 1.0);
        if depth > 0.01 {
            let rate = self.sample_rate.get() as f64;
            self.lfo_phase += FLANGER_LFO_HZ / rate;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }
            let lfo = (self.lfo_phase * std::f64::consts::TAU).sin() * 0.5 + 0.5;
            let delay_s =
                FLANGER_MIN_DELAY_S + (FLANGER_MAX_DELAY_S - FLANGER_MIN_DELAY_S) * lfo;
            let delay_frames = delay_s * rate;
            let whole = delay_frames.floor() as usize;
            let frac = (delay_frames - whole as f64) as f32;
            let delay = if ch == 0 {
                &mut self.delay_l
            } else {
                &mut self.delay_r
            };
            let len = delay.len();
            let i0 = len - 1 - whole.min(len - 1);
            let i1 = len - 1 - (whole + 1).min(len - 1);
            let a = delay.get(i0).copied().unwrap_or(0.0);
            let b = delay.get(i1).copied().unwrap_or(0.0);
            let delayed = a + (b - a) * frac;
            let wet = out as f32 + delayed * FLANGER_FEEDBACK;
            out = (out as f32 * (1.0 - depth * 0.5) + wet * depth * 0.5) as f64;
            delay.pop_back();
            delay.push_front(wet);
        }

        Some(out as f32)
    }
}

impl<S: Source<Item = f32>> Source for DeckFxSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.source.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.source.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.source.try_seek(pos)
    }
}

/// Either decoder the main engine supports.
enum DeckSource {
    Symphonia(Decoder<Cursor<Vec<u8>>>),
    Opus(OpusSource<Cursor<Vec<u8>>>),
}

impl Iterator for DeckSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        match self {
            Self::Symphonia(source) => source.next(),
            Self::Opus(source) => source.next(),
        }
    }
}

impl Source for DeckSource {
    fn current_span_len(&self) -> Option<usize> {
        match self {
            Self::Symphonia(source) => source.current_span_len(),
            Self::Opus(source) => source.current_span_len(),
        }
    }
    fn channels(&self) -> ChannelCount {
        match self {
            Self::Symphonia(source) => source.channels(),
            Self::Opus(source) => source.channels(),
        }
    }
    fn sample_rate(&self) -> SampleRate {
        match self {
            Self::Symphonia(source) => source.sample_rate(),
            Self::Opus(source) => source.sample_rate(),
        }
    }
    fn total_duration(&self) -> Option<Duration> {
        match self {
            Self::Symphonia(source) => source.total_duration(),
            Self::Opus(source) => source.total_duration(),
        }
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        match self {
            Self::Symphonia(source) => source.try_seek(pos),
            Self::Opus(source) => source.try_seek(pos),
        }
    }
}

fn decode_deck(bytes: &[u8]) -> Result<DeckSource, String> {
    let owned = bytes.to_vec();
    if is_ogg_opus(&owned) {
        return Ok(DeckSource::Opus(
            OpusSource::new(owned).map_err(|e| format!("decode: {e}"))?,
        ));
    }
    match Decoder::new(Cursor::new(owned.clone())) {
        Ok(decoder) => Ok(DeckSource::Symphonia(decoder)),
        Err(_) => Ok(DeckSource::Opus(
            OpusSource::new(owned).map_err(|e| format!("decode: {e}"))?,
        )),
    }
}

fn build_deck_player(
    mixer: &Mixer,
    bytes: Arc<Vec<u8>>,
    eq_atoms: Arc<[AtomicU32; 3]>,
    filter_atom: Arc<AtomicU32>,
    flanger_atom: Arc<AtomicU32>,
) -> Result<(Player, Option<f64>), String> {
    let source = decode_deck(&bytes)?;
    let duration = source.total_duration().map(|d| d.as_secs_f64());
    let player = Player::connect_new(mixer);
    player.append(DeckFxSource::new(
        source,
        eq_atoms,
        filter_atom,
        flanger_atom,
    ));
    player.pause();
    Ok((player, duration))
}

/// Waveform overview + a rough BPM estimate, decoded off the playback path.
fn analyze_audio(bytes: &[u8]) -> (Vec<f32>, Option<f64>) {
    let Ok(source) = decode_deck(bytes) else {
        return (Vec::new(), None);
    };
    let channels = source.channels().get() as usize;
    let rate = source.sample_rate().get() as f64;
    let total_frames = source
        .total_duration()
        .map(|d| (d.as_secs_f64() * rate) as usize);

    // Envelope hop for BPM (about 10 ms).
    let hop = (rate * 0.01).max(1.0) as usize;
    let mut envelope: Vec<f64> = Vec::new();
    let mut hop_sum = 0.0f64;
    let mut hop_count = 0usize;

    let bucket_frames = total_frames
        .map(|t| (t / PEAK_BUCKETS).max(1))
        .unwrap_or((rate * 0.25) as usize);
    let mut peaks: Vec<f32> = Vec::with_capacity(PEAK_BUCKETS.min(4096));
    let mut bucket_peak = 0.0f32;
    let mut frame_in_bucket = 0usize;
    let mut frame_index = 0usize;

    for (i, sample) in source.enumerate() {
        let value = sample.abs();
        bucket_peak = bucket_peak.max(value);
        hop_sum += (sample as f64) * (sample as f64);
        hop_count += 1;

        if i % channels == 0 {
            frame_index += 1;
            frame_in_bucket += 1;
        }

        if frame_in_bucket >= bucket_frames {
            peaks.push(bucket_peak);
            bucket_peak = 0.0;
            frame_in_bucket = 0;
        }

        if frame_index > 0 && frame_index % hop == 0 {
            envelope.push((hop_sum / hop_count.max(1) as f64).sqrt());
            hop_sum = 0.0;
            hop_count = 0;
        }
    }
    if frame_in_bucket > 0 {
        peaks.push(bucket_peak);
    }

    let max_peak = peaks.iter().copied().fold(0.0f32, f32::max);
    if max_peak > 0.0 {
        for peak in peaks.iter_mut() {
            *peak /= max_peak;
        }
    }
    peaks.truncate(PEAK_BUCKETS);

    (peaks, estimate_bpm(&envelope, rate / hop as f64))
}

/// Autocorrelation over the onset envelope, restricted to 60..180 BPM.
fn estimate_bpm(envelope: &[f64], envelope_rate: f64) -> Option<f64> {
    if envelope.len() < 64 {
        return None;
    }
    let mut onset: Vec<f64> = Vec::with_capacity(envelope.len());
    for i in 0..envelope.len() {
        let prev = if i == 0 { envelope[0] } else { envelope[i - 1] };
        onset.push((envelope[i] - prev).max(0.0));
    }
    let mean = onset.iter().sum::<f64>() / onset.len() as f64;
    if mean <= 1e-6 {
        return None;
    }
    let centered: Vec<f64> = onset.iter().map(|v| v - mean).collect();

    let min_bpm = 60.0;
    let max_bpm = 180.0;
    let min_lag = (envelope_rate * 60.0 / max_bpm).floor() as usize;
    let max_lag = (envelope_rate * 60.0 / min_bpm).ceil() as usize;
    if max_lag >= centered.len() {
        return None;
    }

    let mut best_lag = 0usize;
    let mut best_score = 0.0f64;
    for lag in min_lag..=max_lag {
        let mut sum = 0.0f64;
        let mut norm = 0.0f64;
        for i in lag..centered.len() {
            sum += centered[i] * centered[i - lag];
            norm += centered[i] * centered[i];
        }
        if norm <= 0.0 {
            continue;
        }
        let score = sum / norm;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best_score < 0.05 {
        return None;
    }
    Some(60.0 * envelope_rate / best_lag as f64)
}

/// Apply `deck volume × crossfader × app volume` to every loaded deck.
fn apply_volumes(state: &AudioState) {
    let x = f32::from_bits(state.dj.crossfade.load(Ordering::Relaxed)).clamp(0.0, 1.0);
    let master = *state.volume.lock().unwrap();
    let factor_a = (x * std::f32::consts::FRAC_PI_2).cos();
    let factor_b = (x * std::f32::consts::FRAC_PI_2).sin();
    let decks = state.dj.decks.lock().unwrap();
    for (index, deck) in decks.iter().enumerate() {
        if let Some(ref player) = deck.player {
            let factor = if index == 0 { factor_a } else { factor_b };
            player.set_volume((deck.volume * factor * master).clamp(0.0, 2.0));
        }
    }
}

fn deck_index(deck: u8) -> Result<usize, String> {
    if deck <= 1 {
        Ok(deck as usize)
    } else {
        Err("invalid deck".into())
    }
}

/// Tick-thread step: run deck loops, advance the auto-mix crossfade, keep
/// volumes in sync with the app volume and broadcast deck positions.
pub fn process_decks(handle: &AppHandle, state: &AudioState) {
    if !state.dj.active.load(Ordering::Relaxed) {
        return;
    }

    let automix = state.dj.automix.load(Ordering::Relaxed);
    let crossfade_value = f32::from_bits(state.dj.crossfade.load(Ordering::Relaxed));

    // Auto-mix: when the playing deck nears its end, start the other deck and
    // fade over. Runs before the deck lock so it can play/pause freely.
    if automix {
        let now = now_ms();
        let fade_ms = state.dj.automix_fade_ms.load(Ordering::Relaxed).max(500);
        let mut run = state.dj.automix_run.lock().unwrap();
        if let Some(active_run) = run.as_ref() {
            let t = ((now.saturating_sub(active_run.started_ms)) as f32 / fade_ms as f32)
                .clamp(0.0, 1.0);
            let from = active_run.from;
            let target = if from == 0 { 1.0 } else { 0.0 };
            let value = active_run.from_value + (target - active_run.from_value) * t;
            state
                .dj
                .crossfade
                .store(value.to_bits(), Ordering::Relaxed);
            if t >= 1.0 {
                let decks = state.dj.decks.lock().unwrap();
                if let Some(ref player) = decks[from].player {
                    player.pause();
                }
                *run = None;
            }
        } else {
            let decks = state.dj.decks.lock().unwrap();
            for index in 0..2 {
                if !decks[index].is_playing() {
                    continue;
                }
                let other = 1 - index;
                // Fade only into a loaded, resumable deck — never into silence.
                if decks[other].player.is_none()
                    || decks[other]
                        .player
                        .as_ref()
                        .map(|p| p.empty())
                        .unwrap_or(true)
                {
                    break;
                }
                let position = decks[index].player.as_ref().map(|p| {
                    p.get_pos().as_secs_f64() * decks[index].speed.max(0.01) as f64
                });
                let remaining = decks[index]
                    .duration
                    .zip(position)
                    .map(|(duration, position)| duration - position)
                    .unwrap_or(f64::MAX);
                if remaining <= fade_ms as f64 / 1000.0 {
                    if let Some(ref player) = decks[other].player {
                        player.play();
                    }
                    *run = Some(AutomixRun {
                        from: index,
                        started_ms: now,
                        duration_ms: fade_ms,
                        from_value: f32::from_bits(
                            state.dj.crossfade.load(Ordering::Relaxed),
                        ),
                    });
                }
                break;
            }
        }
        drop(run);
    }

    apply_volumes(state);
    let crossfade_now = f32::from_bits(state.dj.crossfade.load(Ordering::Relaxed));

    let mut ticks = Vec::with_capacity(2);
    {
        let mut decks = state.dj.decks.lock().unwrap();
        for (index, deck) in decks.iter_mut().enumerate() {
            let rate = deck.speed.max(0.01) as f64;
            if let Some(ref player) = deck.player {
                let mut position = player.get_pos().as_secs_f64() * rate;
                if let Some((a, b)) = deck.loop_region
                    && position >= b
                {
                    let _ = player.try_seek(Duration::from_secs_f64(a / rate));
                    position = a;
                }
                ticks.push(DjDeckTick {
                    deck: index as u8,
                    loaded: true,
                    playing: !player.is_paused() && !player.empty(),
                    position,
                    duration: deck.duration,
                    crossfade: crossfade_now,
                    automix,
                });
            } else {
                ticks.push(DjDeckTick {
                    deck: index as u8,
                    loaded: false,
                    playing: false,
                    position: 0.0,
                    duration: None,
                    crossfade: crossfade_now,
                    automix,
                });
            }
        }
    }
    handle.emit("dj:tick", ticks).ok();
}

/* ── Commands ─────────────────────────────────────────────────── */

#[tauri::command]
pub async fn dj_load(
    deck: u8,
    path: String,
    state: State<'_, AudioState>,
) -> Result<DjDeckInfo, String> {
    let index = deck_index(deck)?;
    let mixer = state.mixer.lock().map_err(|e| e.to_string())?.clone();
    let (eq_atoms, filter_atom, flanger_atom) = {
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        let deck = &decks[index];
        (
            deck.eq_atoms.clone(),
            deck.filter_atom.clone(),
            deck.flanger_atom.clone(),
        )
    };

    let bytes = Arc::new(
        tokio::fs::read(&path)
            .await
            .map_err(|e| format!("read {path}: {e}"))?,
    );
    let bytes_for_build = bytes.clone();
    let (player, duration, analysis) = tokio::task::spawn_blocking(move || {
        let (player, duration) = build_deck_player(
            &mixer,
            bytes_for_build.clone(),
            eq_atoms,
            filter_atom,
            flanger_atom,
        )?;
        let analysis = analyze_audio(&bytes_for_build);
        Ok::<_, String>((player, duration, analysis))
    })
    .await
    .map_err(|e| format!("decode task: {e}"))??;

    {
        let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        if let Some(old) = decks[index].player.take() {
            old.stop();
        }
        decks[index].player = Some(player);
        decks[index].bytes = Some(bytes);
        decks[index].duration = duration;
        decks[index].bpm = analysis.1;
        decks[index].loop_region = None;
        decks[index].speed = 1.0;
        if let Some(ref player) = decks[index].player {
            player.set_speed(1.0);
        }
    }
    apply_volumes(&state);
    Ok(DjDeckInfo {
        duration_secs: duration,
        peaks: analysis.0,
        bpm: analysis.1,
    })
}

#[tauri::command]
pub fn dj_unload(deck: u8, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    if let Some(old) = decks[index].player.take() {
        old.stop();
    }
    decks[index].bytes = None;
    decks[index].duration = None;
    decks[index].bpm = None;
    decks[index].loop_region = None;
    Ok(())
}

/// Rebuild an ended/stopped deck from its stored bytes at `position` seconds.
async fn rebuild_deck(state: &AudioState, index: usize, position: f64) -> Result<(), String> {
    let mixer = state.mixer.lock().map_err(|e| e.to_string())?.clone();
    let (bytes, eq_atoms, filter_atom, flanger_atom, speed) = {
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        let deck = &decks[index];
        let bytes = deck
            .bytes
            .clone()
            .ok_or("deck has no source to rebuild from")?;
        (
            bytes,
            deck.eq_atoms.clone(),
            deck.filter_atom.clone(),
            deck.flanger_atom.clone(),
            deck.speed,
        )
    };
    let (player, _) = tokio::task::spawn_blocking(move || {
        build_deck_player(&mixer, bytes, eq_atoms, filter_atom, flanger_atom)
    })
    .await
    .map_err(|e| format!("decode task: {e}"))??;
    let rate = speed.max(0.01) as f64;
    player.set_speed(speed);
    if position > 0.0 {
        player
            .try_seek(Duration::from_secs_f64(position / rate))
            .ok();
    }
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    if let Some(old) = decks[index].player.take() {
        old.stop();
    }
    decks[index].player = Some(player);
    Ok(())
}

#[tauri::command]
pub async fn dj_play(deck: u8, playing: bool, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let (loaded, empty) = {
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        (
            decks[index].player.is_some(),
            decks[index]
                .player
                .as_ref()
                .map(|p| p.empty())
                .unwrap_or(false),
        )
    };
    if !loaded {
        return Ok(());
    }
    // An ended source can't be resumed — rebuild it from the stored bytes.
    if playing && empty {
        let position = {
            let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
            decks[index].loop_region.map(|(a, _)| a).unwrap_or(0.0)
        };
        rebuild_deck(&state, index, position).await?;
    }
    let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    if let Some(ref player) = decks[index].player {
        if playing {
            player.play();
        } else {
            player.pause();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn dj_seek(deck: u8, position: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let (loaded, empty) = {
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        (
            decks[index].player.is_some(),
            decks[index]
                .player
                .as_ref()
                .map(|p| p.empty())
                .unwrap_or(false),
        )
    };
    if !loaded {
        return Ok(());
    }
    if empty {
        // Ended source: rodio silently ignores seeks on empty players.
        return rebuild_deck(&state, index, position.max(0.0)).await;
    }
    let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    let deck = &decks[index];
    if let Some(ref player) = deck.player {
        let rate = deck.speed.max(0.01) as f64;
        player
            .try_seek(Duration::from_secs_f64((position / rate).max(0.0)))
            .map_err(|e| format!("seek: {e:?}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn dj_set_volume(deck: u8, volume: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    {
        let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        decks[index].volume = (volume as f32).clamp(0.0, 2.0);
    }
    apply_volumes(&state);
    Ok(())
}

#[tauri::command]
pub fn dj_set_speed(deck: u8, speed: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    let deck = &mut decks[index];
    let value = (speed as f32).clamp(0.5, 2.0);
    deck.speed = value;
    if let Some(ref player) = deck.player {
        player.set_speed(value);
    }
    Ok(())
}

#[tauri::command]
pub fn dj_set_eq(
    deck: u8,
    low: f64,
    mid: f64,
    high: f64,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    let deck = &mut decks[index];
    let gains = [
        low.clamp(-12.0, 12.0),
        mid.clamp(-12.0, 12.0),
        high.clamp(-12.0, 12.0),
    ];
    deck.eq_gains = gains;
    for (i, gain) in gains.iter().enumerate() {
        deck.eq_atoms[i].store((*gain as f32).to_bits(), Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn dj_set_filter(deck: u8, value: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    let deck = &mut decks[index];
    let value = (value as f32).clamp(-1.0, 1.0);
    deck.filter_value = value;
    deck.filter_atom.store(value.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn dj_set_flanger(deck: u8, value: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    let deck = &mut decks[index];
    let value = (value as f32).clamp(0.0, 1.0);
    deck.flanger_value = value;
    deck.flanger_atom.store(value.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn dj_set_loop(
    deck: u8,
    a: Option<f64>,
    b: Option<f64>,
    state: State<'_, AudioState>,
) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    decks[index].loop_region = match (a, b) {
        (Some(a), Some(b)) if b > a + 0.05 => Some((a.max(0.0), b)),
        _ => None,
    };
    Ok(())
}

#[tauri::command]
pub fn dj_set_crossfade(value: f64, state: State<'_, AudioState>) -> Result<(), String> {
    state.dj.crossfade.store(
        (value.clamp(0.0, 1.0) as f32).to_bits(),
        Ordering::Relaxed,
    );
    apply_volumes(&state);
    Ok(())
}

#[tauri::command]
pub fn dj_set_automix(enabled: bool, state: State<'_, AudioState>) -> Result<(), String> {
    state.dj.automix.store(enabled, Ordering::Relaxed);
    if !enabled {
        *state.dj.automix_run.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
pub fn dj_set_active(active: bool, state: State<'_, AudioState>) -> Result<(), String> {
    state.dj.active.store(active, Ordering::Relaxed);
    if active {
        apply_volumes(&state);
    } else {
        // Leaving DJ mode silences both decks (they stay loaded).
        *state.dj.automix_run.lock().unwrap() = None;
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        for deck in decks.iter() {
            if let Some(ref player) = deck.player {
                player.pause();
            }
        }
    }
    Ok(())
}
