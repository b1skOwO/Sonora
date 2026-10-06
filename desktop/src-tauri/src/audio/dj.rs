//! Two-deck DJ mixer riding the shared output mixer.
//!
//! Each deck is an independent rodio `Player` on the same mixer as the main
//! player: it decodes a cached track, applies a 3-band EQ, and exposes
//! play/pause, seek, tempo (speed, pitch follows) and an A-B loop. The
//! crossfader is an equal-power blend applied in the tick thread, which also
//! runs the deck loops and emits `dj:tick` for the UI.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
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

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DjDeckTick {
    pub deck: u8,
    pub loaded: bool,
    pub playing: bool,
    pub position: f64,
    pub duration: Option<f64>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DjDeckInfo {
    pub duration_secs: Option<f64>,
}

pub struct Deck {
    pub player: Option<Player>,
    pub duration: Option<f64>,
    /// 0.0..2.0 (multiplied by the crossfader and the app volume).
    pub volume: f32,
    /// 0.5..2.0, pitch follows speed.
    pub speed: f32,
    /// Low / mid / high gains in dB (-12..+12).
    pub eq_gains: [f64; 3],
    pub eq_atoms: Arc<[AtomicU32; 3]>,
    /// Loop region in source seconds.
    pub loop_region: Option<(f64, f64)>,
}

impl Deck {
    fn new() -> Self {
        Self {
            player: None,
            duration: None,
            volume: 0.8,
            speed: 1.0,
            eq_gains: [0.0; 3],
            eq_atoms: Arc::new([
                AtomicU32::new(0f32.to_bits()),
                AtomicU32::new(0f32.to_bits()),
                AtomicU32::new(0f32.to_bits()),
            ]),
            loop_region: None,
        }
    }
}

pub struct DjState {
    pub decks: Mutex<[Deck; 2]>,
    /// 0.0 = deck A only, 1.0 = deck B only (equal-power blend).
    pub crossfade: AtomicU32,
    pub active: AtomicBool,
}

impl DjState {
    pub fn new() -> Self {
        Self {
            decks: Mutex::new([Deck::new(), Deck::new()]),
            crossfade: AtomicU32::new(0f32.to_bits()),
            active: AtomicBool::new(false),
        }
    }
}

/// Per-deck 3-band EQ reading its gains from shared atomics (f32 dB bits).
struct DeckEqSource<S> {
    source: S,
    gains: Arc<[AtomicU32; 3]>,
    filters_l: [DirectForm1<f64>; 3],
    filters_r: [DirectForm1<f64>; 3],
    channels: ChannelCount,
    sample_rate: SampleRate,
    current_channel: u16,
    cached: [f64; 3],
}

impl<S: Source<Item = f32>> DeckEqSource<S> {
    fn new(source: S, gains: Arc<[AtomicU32; 3]>) -> Self {
        let sample_rate = source.sample_rate();
        let channels = source.channels();
        let fs: Hertz<f64> = (sample_rate.get() as f64).hz();
        let make_filters = || {
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

        Self {
            source,
            gains,
            filters_l: make_filters(),
            filters_r: make_filters(),
            channels,
            sample_rate,
            current_channel: 0,
            cached: [0.0; 3],
        }
    }

    fn refresh(&mut self) {
        let fs: Hertz<f64> = (self.sample_rate.get() as f64).hz();
        for i in 0..3 {
            let gain = f32::from_bits(self.gains[i].load(Ordering::Relaxed)) as f64;
            if (gain - self.cached[i]).abs() < 0.01 {
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
                self.filters_l[i] = DirectForm1::<f64>::new(coeffs);
                self.filters_r[i] = DirectForm1::<f64>::new(coeffs);
            }
            self.cached[i] = gain;
        }
    }
}

impl<S: Source<Item = f32>> Iterator for DeckEqSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.source.next()?;
        let ch = self.current_channel;
        self.current_channel = (ch + 1) % self.channels.get();
        self.refresh();

        let mut out = sample as f64;
        let filters = if ch == 0 {
            &mut self.filters_l
        } else {
            &mut self.filters_r
        };
        for filter in filters.iter_mut() {
            out = Biquad::run(filter, out);
        }
        Some(out as f32)
    }
}

impl<S: Source<Item = f32>> Source for DeckEqSource<S> {
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

fn decode_deck(bytes: Vec<u8>) -> Result<DeckSource, String> {
    if is_ogg_opus(&bytes) {
        return Ok(DeckSource::Opus(
            OpusSource::new(bytes).map_err(|e| format!("decode: {e}"))?,
        ));
    }
    match Decoder::new(Cursor::new(bytes.clone())) {
        Ok(decoder) => Ok(DeckSource::Symphonia(decoder)),
        Err(_) => Ok(DeckSource::Opus(
            OpusSource::new(bytes).map_err(|e| format!("decode: {e}"))?,
        )),
    }
}

fn build_deck_player(
    mixer: &Mixer,
    bytes: Vec<u8>,
    eq_atoms: Arc<[AtomicU32; 3]>,
) -> Result<(Player, Option<f64>), String> {
    let source = decode_deck(bytes)?;
    let duration = source.total_duration().map(|d| d.as_secs_f64());
    let player = Player::connect_new(mixer);
    player.append(DeckEqSource::new(source, eq_atoms));
    player.pause();
    Ok((player, duration))
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

/// Tick-thread step: run deck loops, keep volumes in sync with the app volume
/// and broadcast the deck positions to the UI.
pub fn process_decks(handle: &AppHandle, state: &AudioState) {
    if !state.dj.active.load(Ordering::Relaxed) {
        return;
    }
    apply_volumes(state);

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
                });
            } else {
                ticks.push(DjDeckTick {
                    deck: index as u8,
                    loaded: false,
                    playing: false,
                    position: 0.0,
                    duration: None,
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
    let eq_atoms = {
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        decks[index].eq_atoms.clone()
    };

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {path}: {e}"))?;
    let (player, duration) =
        tokio::task::spawn_blocking(move || build_deck_player(&mixer, bytes, eq_atoms))
            .await
            .map_err(|e| format!("decode task: {e}"))??;

    {
        let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        if let Some(old) = decks[index].player.take() {
            old.stop();
        }
        decks[index].player = Some(player);
        decks[index].duration = duration;
        decks[index].loop_region = None;
        decks[index].speed = 1.0;
        if let Some(ref player) = decks[index].player {
            player.set_speed(1.0);
        }
    }
    apply_volumes(&state);
    Ok(DjDeckInfo {
        duration_secs: duration,
    })
}

#[tauri::command]
pub fn dj_unload(deck: u8, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
    let mut decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
    if let Some(old) = decks[index].player.take() {
        old.stop();
    }
    decks[index].duration = None;
    decks[index].loop_region = None;
    Ok(())
}

#[tauri::command]
pub fn dj_play(deck: u8, playing: bool, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
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
pub fn dj_seek(deck: u8, position: f64, state: State<'_, AudioState>) -> Result<(), String> {
    let index = deck_index(deck)?;
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
pub fn dj_set_active(active: bool, state: State<'_, AudioState>) -> Result<(), String> {
    state.dj.active.store(active, Ordering::Relaxed);
    if active {
        apply_volumes(&state);
    } else {
        // Leaving DJ mode silences both decks (they stay loaded).
        let decks = state.dj.decks.lock().map_err(|e| e.to_string())?;
        for deck in decks.iter() {
            if let Some(ref player) = deck.player {
                player.pause();
            }
        }
    }
    Ok(())
}
