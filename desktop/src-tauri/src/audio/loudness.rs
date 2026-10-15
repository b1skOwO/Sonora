//! ITU-R BS.1770-4 / EBU R128 loudness measurement.
//!
//! The per-track gain model is ReplayGain-style: one static gain per track
//! (no compression, no limiting — dynamics stay untouched), derived from the
//! gated integrated loudness (LUFS) of the analysis window. The K-weighting
//! filters are rebuilt from the analog prototype (the same approach as
//! libebur128), so any source sample rate lands on the standard curve that
//! BS.1770 tabulates for 48 kHz.

use std::collections::VecDeque;

use rodio::Source;

use crate::audio::types::{
    NORMALIZATION_ANALYSIS_SECONDS, NORMALIZATION_MAX_ATTENUATION_DB, NORMALIZATION_MAX_BOOST_DB,
    NORMALIZATION_SAFETY_PEAK, NORMALIZATION_TARGET_LUFS,
};

/// Peak + gated integrated loudness of the analysis window — the numbers the
/// loudness and safety gains are derived from.
#[derive(Clone, Copy, Debug)]
pub struct LoudnessAnalysis {
    pub peak: f64,
    /// Integrated loudness in LUFS; negative infinity when nothing in the
    /// window rises above the absolute gate (silence).
    pub lufs: f64,
}

/// Offset of the BS.1770 loudness formula.
const LOUDNESS_OFFSET: f64 = -0.691;
/// Absolute gate of BS.1770-4, in LUFS.
const ABSOLUTE_GATE_LUFS: f64 = -70.0;
/// Relative gate of BS.1770-4, in LU.
const RELATIVE_GATE_LU: f64 = 10.0;
/// Block length (400 ms) at 75% overlap, expressed in 100 ms hops.
const BLOCK_SEGMENTS: usize = 4;

/// One biquad of the K-weighting chain with coefficients normalized so
/// `a0 = 1`.
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

#[derive(Clone, Copy, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

impl Biquad {
    /// Transposed direct form II.
    fn process(&self, state: &mut BiquadState, x: f64) -> f64 {
        let y = self.b0 * x + state.z1;
        state.z1 = self.b1 * x - self.a1 * y + state.z2;
        state.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// K-weighting filter pair for `sample_rate`, rebuilt from the analog
/// prototype so the 48 kHz curve of BS.1770-4 applies at 44.1 kHz and every
/// other rate too.
fn k_weighting(sample_rate: f64) -> (Biquad, Biquad) {
    use std::f64::consts::PI;

    // Stage 1: high-shelf (+4 dB above ~1.7 kHz).
    let f0 = 1681.974_450_955_533;
    let g = 3.999_843_853_973_347;
    let q = 0.707_175_236_955_419_6;
    let k = (PI * f0 / sample_rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    };

    // Stage 2: RLB high-pass (2nd order, ≈ -3 dB at 38 Hz).
    let f0 = 38.135_470_876_024_44;
    let q = 0.500_327_037_323_877_3;
    let k = (PI * f0 / sample_rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    };

    (shelf, high_pass)
}

/// Peak + gated integrated loudness (BS.1770-4) of the first
/// [`NORMALIZATION_ANALYSIS_SECONDS`] of `source`. Accepts any rodio source —
/// the interleaved f32 iterator the decode module feeds it is all it needs.
pub fn measure<S: Source<Item = f32>>(source: S) -> LoudnessAnalysis {
    let channels = source.channels().get() as usize;
    let sample_rate = source.sample_rate().get() as f64;
    // 100 ms hop: `hop_frames` per channel, `hop` interleaved.
    let hop_frames = ((sample_rate * 0.1).round() as usize).max(1);
    let hop = hop_frames * channels;
    let limit = (sample_rate * channels as f64 * NORMALIZATION_ANALYSIS_SECONDS) as usize;

    let (shelf, high_pass) = k_weighting(sample_rate);
    let mut shelf_states = vec![BiquadState::default(); channels];
    let mut high_pass_states = vec![BiquadState::default(); channels];

    let mut peak = 0.0f64;
    // Energy of the segment in progress (sum of K-weighted squares, all
    // channels).
    let mut segment_sum = 0.0f64;
    let mut segment_samples = 0usize;
    // The last [`BLOCK_SEGMENTS`] completed segment sums (sliding 400 ms).
    let mut recent: VecDeque<f64> = VecDeque::with_capacity(BLOCK_SEGMENTS);
    // Mean square of every completed block, summed over channels (`z` in
    // BS.1770-4 terms).
    let mut blocks: Vec<f64> = Vec::with_capacity(limit / hop + 1);

    let mut channel = 0usize;
    for sample in source.take(limit) {
        let raw = sample as f64;
        peak = peak.max(raw.abs());

        let weighted = high_pass.process(
            &mut high_pass_states[channel],
            shelf.process(&mut shelf_states[channel], raw),
        );
        segment_sum += weighted * weighted;
        segment_samples += 1;
        channel += 1;
        if channel == channels {
            channel = 0;
        }

        if segment_samples == hop {
            recent.push_back(segment_sum);
            if recent.len() > BLOCK_SEGMENTS {
                recent.pop_front();
            }
            if recent.len() == BLOCK_SEGMENTS {
                // Mean square summed over channels: the block's total energy
                // over the samples of one channel in a 400 ms block.
                blocks.push(
                    recent.iter().sum::<f64>() / (BLOCK_SEGMENTS * hop_frames) as f64,
                );
            }
            segment_sum = 0.0;
            segment_samples = 0;
        }
    }

    // Shorter than one full block: integrate whatever was decoded (pending
    // segments plus the partial tail) as a single block.
    if blocks.is_empty() {
        let interleaved = recent.len() * hop + segment_samples;
        if interleaved > 0 {
            let total = recent.iter().sum::<f64>() + segment_sum;
            blocks.push(total / (interleaved as f64 / channels as f64));
        }
    }

    LoudnessAnalysis {
        peak,
        lufs: integrated_loudness(&blocks),
    }
}

/// BS.1770-4 gated integration over block mean squares: absolute gate at
/// -70 LUFS, then the -10 LU relative gate.
fn integrated_loudness(blocks: &[f64]) -> f64 {
    let gate_z = 10f64.powf((ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10.0);
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for &z in blocks {
        if z > gate_z {
            sum += z;
            count += 1;
        }
    }
    if count == 0 {
        return f64::NEG_INFINITY;
    }

    // Relative threshold: -10 LU below the ungated loudness of the surviving
    // blocks, never below the absolute gate.
    let relative_z = (sum / count as f64) / 10f64.powf(RELATIVE_GATE_LU / 10.0);
    let threshold = gate_z.max(relative_z);

    sum = 0.0;
    count = 0;
    for &z in blocks {
        if z > threshold {
            sum += z;
            count += 1;
        }
    }
    if count == 0 {
        return f64::NEG_INFINITY;
    }

    LOUDNESS_OFFSET + 10.0 * (sum / count as f64).log10()
}

/// Static per-track gain for the normalization setting: brings the measured
/// gated loudness to [`NORMALIZATION_TARGET_LUFS`] (the -14 LUFS streaming
/// standard), clamped to [-24, +12] dB and snapped to unity when it lands
/// close to it. The applied gain is `min(loudness, safety)` — the safety gain
/// is what keeps boosts from pushing already-over-full-scale decoded peaks
/// into clipping, not this one.
pub fn loudness_gain(analysis: LoudnessAnalysis) -> f32 {
    if !analysis.lufs.is_finite() {
        return 1.0;
    }

    let max_boost = 10f64.powf(NORMALIZATION_MAX_BOOST_DB / 20.0);
    let max_attenuation = 10f64.powf(NORMALIZATION_MAX_ATTENUATION_DB / 20.0);
    let gain = 10f64
        .powf((NORMALIZATION_TARGET_LUFS - analysis.lufs) / 20.0)
        .clamp(max_attenuation, max_boost);

    if (gain - 1.0).abs() < 0.05 {
        1.0
    } else {
        gain as f32
    }
}

/// Always-on peak safety: attenuation-only gain that keeps decoded samples
/// (which overshoot full scale by up to several dB in lossy sources) from hard
/// clipping at the output. Applied regardless of the normalization setting — it
/// is a static gain, so dynamics are untouched.
pub fn peak_safety_gain(peak: f64) -> f32 {
    (NORMALIZATION_SAFETY_PEAK / peak.max(1e-6)).min(1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZero;

    fn source(data: Vec<f32>) -> impl Source<Item = f32> {
        rodio::buffer::SamplesBuffer::new(
            NonZero::new(2u16).unwrap(),
            NonZero::new(48_000u32).unwrap(),
            data,
        )
    }

    /// Stereo 1 kHz sine, interleaved.
    fn tone(amplitude: f64, seconds: f64) -> Vec<f32> {
        let rate = 48_000.0;
        let frames = (rate * seconds) as usize;
        let mut out = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let value =
                (amplitude * (std::f64::consts::TAU * 1000.0 * i as f64 / rate).sin()) as f32;
            out.extend_from_slice(&[value, value]);
        }
        out
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    /// The analog-prototype coefficients must reproduce the 48 kHz tables
    /// published in BS.1770-4.
    #[test]
    fn k_weighting_matches_bs1770_table() {
        let (shelf, high_pass) = k_weighting(48_000.0);
        assert!(close(shelf.b0, 1.53512485958697));
        assert!(close(shelf.b1, -2.69169618940638));
        assert!(close(shelf.b2, 1.19839281085285));
        assert!(close(shelf.a1, -1.69065929318241));
        assert!(close(shelf.a2, 0.73248077421585));
        assert!(close(high_pass.b0, 1.0));
        assert!(close(high_pass.b1, -2.0));
        assert!(close(high_pass.b2, 1.0));
        assert!(close(high_pass.a1, -1.99004745483398));
        assert!(close(high_pass.a2, 0.99007225036621));
    }

    /// A full-scale stereo 1 kHz sine: z = |H(1k)|² ≈ 1.174, so the integrated
    /// loudness lands at ≈ +0.007 LUFS.
    #[test]
    fn full_scale_sine_measures_near_zero_lufs() {
        let analysis = measure(source(tone(1.0, 10.0)));
        assert!((analysis.peak - 1.0).abs() < 1e-6);
        assert!(
            (analysis.lufs - 0.007).abs() < 0.2,
            "lufs = {}",
            analysis.lufs
        );
    }

    /// Halving the amplitude drops the loudness by exactly 6.02 LU.
    #[test]
    fn half_amplitude_sine_drops_six_lu() {
        let analysis = measure(source(tone(0.5, 10.0)));
        assert!(
            (analysis.lufs - (0.007 - 6.0206)).abs() < 0.2,
            "lufs = {}",
            analysis.lufs
        );
    }

    /// Leading silence must be gated out instead of dragging the integrated
    /// loudness down.
    #[test]
    fn leading_silence_is_gated_out() {
        let mut data = vec![0f32; 48_000 * 2 * 4];
        data.extend(tone(0.5, 6.0));
        let analysis = measure(source(data));
        assert!(
            (analysis.lufs - (0.007 - 6.0206)).abs() < 0.2,
            "lufs = {}",
            analysis.lufs
        );
    }

    /// Sources shorter than a single 400 ms block still measure.
    #[test]
    fn sub_block_source_uses_partial_window() {
        let analysis = measure(source(tone(1.0, 0.25)));
        assert!(
            (analysis.lufs - 0.007).abs() < 0.3,
            "lufs = {}",
            analysis.lufs
        );
    }

    /// Silence never divides by zero — it reports -inf and unity gain.
    #[test]
    fn silence_is_negative_infinity() {
        let analysis = measure(source(vec![0f32; 48_000 * 2 * 3]));
        assert_eq!(analysis.lufs, f64::NEG_INFINITY);
        assert_eq!(loudness_gain(analysis), 1.0);
    }

    #[test]
    fn loudness_gain_matches_target_and_clamps() {
        let gain = |lufs: f64| loudness_gain(LoudnessAnalysis { peak: 1.0, lufs });

        // -20 LUFS: +6 dB boost.
        assert!((gain(-20.0) - 1.99526).abs() < 1e-3);
        // -6 LUFS: -8 dB attenuation.
        assert!((gain(-6.0) - 0.39811).abs() < 1e-3);
        // Boost clamps at +12 dB.
        assert!((gain(-50.0) - 3.98107).abs() < 1e-3);
        // Attenuation clamps at -24 dB.
        assert!((gain(10.0) - 0.063096).abs() < 1e-3);
        // Within 0.05 of unity: snapped.
        assert_eq!(gain(-14.2), 1.0);
    }

    #[test]
    fn safety_gain_only_attenuates() {
        assert!((peak_safety_gain(1.0) - 0.79).abs() < 1e-6);
        assert_eq!(peak_safety_gain(0.5), 1.0);
        assert!((peak_safety_gain(2.0) - 0.395).abs() < 1e-6);
    }
}
