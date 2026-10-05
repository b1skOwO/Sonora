//! Band-limited sample-rate conversion for the output chain.
//!
//! rodio's mixer converts every appended source to the device rate with linear
//! interpolation — and plain sample dropping when down-sampling
//! ([RustAudio/rodio#584]). Linear interpolation costs roughly 4 dB at 16 kHz
//! and 6 dB at 20 kHz when 44.1 kHz content lands on a 48 kHz device, which is
//! audibly duller than the sinc-resampling browser pipeline SoundCloud streams
//! through. Wrapping the final chain stage in this windowed-sinc converter
//! makes the mixer see an already-matching rate, so its own conversion passes
//! samples through untouched.
//!
//! [RustAudio/rodio#584]: https://github.com/RustAudio/rodio/issues/584

use std::collections::VecDeque;
use std::f64::consts::PI;
use std::time::Duration;

use crate::audio::types::{ChannelCount, SampleRate};
use rodio::source::SeekError;
use rodio::Source;

/// Kernel taps per output sample. 64 taps keep the passband flat to ~19 kHz
/// while the cost stays negligible (~6M multiply-adds/s for 48 kHz stereo).
const TAPS: usize = 64;
/// Quantised fractional-delay steps in the polyphase kernel table.
const PHASES: usize = 256;
/// Pass-band guard: keep the filter a little inside Nyquist so the transition
/// band never eats into the audible range.
const CUTOFF_GUARD: f64 = 0.95;

/// A `Source` adapter that converts its input to `out_rate` with a polyphase
/// windowed-sinc kernel. Used only when the source rate differs from the
/// device rate; identical rates stay on the untouched path.
pub struct ResampleSource<S> {
    input: S,
    channels: ChannelCount,
    out_rate: SampleRate,
    /// Input frames consumed per output frame (`in_rate / out_rate`).
    step: f64,
    /// `PHASES × TAPS` windowed-sinc table, one row per fractional delay.
    kernel: Vec<f32>,
    /// Interleaved frames pulled from `input`; the front frame is `history_frame`.
    history: VecDeque<f32>,
    /// Absolute input-frame index of `history.front()`.
    history_frame: u64,
    /// Absolute input-frame index of the next frame to pull.
    next_frame: u64,
    /// Absolute output-frame index to emit next.
    out_frame: u64,
    eof: bool,
    /// Interleaved output frame being handed out, and the cursor into it.
    pending: Vec<f32>,
    pending_pos: usize,
}

impl<S: Source<Item = f32>> ResampleSource<S> {
    pub fn new(input: S, out_rate: SampleRate) -> Self {
        let in_rate = input.sample_rate().get();
        let out = out_rate.get();
        let step = in_rate as f64 / out as f64;
        // Normalised to the input rate: 0.5 is the input Nyquist. Down-sampling
        // tightens the kernel so nothing above the output Nyquist survives.
        let fc = 0.5 * (out.min(in_rate) as f64 / in_rate as f64) * CUTOFF_GUARD;
        let channels = input.channels();

        Self {
            input,
            channels,
            out_rate,
            step,
            kernel: build_kernel(fc),
            history: VecDeque::with_capacity((TAPS + 2) * channels.get() as usize),
            history_frame: 0,
            next_frame: 0,
            out_frame: 0,
            eof: false,
            pending: Vec::with_capacity(channels.get() as usize),
            pending_pos: 0,
        }
    }

    /// Rebase all counters to the source's post-seek position. The input now
    /// starts at the seek target, which becomes local time zero.
    fn reset(&mut self) {
        self.history.clear();
        self.pending.clear();
        self.pending_pos = 0;
        self.history_frame = 0;
        self.next_frame = 0;
        self.out_frame = 0;
        self.eof = false;
    }
}

/// Build the polyphase windowed-sinc table. `fc` is the filter cutoff
/// normalised to the input rate (0.5 = input Nyquist).
fn build_kernel(fc: f64) -> Vec<f32> {
    let half = (TAPS / 2) as f64;
    let mut kernel = vec![0f32; PHASES * TAPS];

    for (phase, row) in kernel.chunks_exact_mut(TAPS).enumerate() {
        let frac = phase as f64 / PHASES as f64;
        let mut sum = 0.0f64;
        for (k, tap) in row.iter_mut().enumerate() {
            // Distance in input frames from the interpolation point `n0 + frac`
            // to the kernel tap sitting on frame `n0 - half + 1 + k`.
            let u = k as f64 - (half - 1.0) - frac;
            let x = u / half;
            // Blackman window over the kernel support, zero at both ends.
            let window = if x.abs() >= 1.0 {
                0.0
            } else {
                0.42 + 0.5 * (PI * x).cos() + 0.08 * (2.0 * PI * x).cos()
            };
            let value = if u == 0.0 {
                2.0 * fc
            } else {
                (2.0 * PI * fc * u).sin() / (PI * u)
            } * window;
            *tap = value as f32;
            sum += value;
        }
        // Exact unity DC gain per phase: no level or DC ripple between phases.
        if sum != 0.0 {
            for tap in row.iter_mut() {
                *tap = (*tap as f64 / sum) as f32;
            }
        }
    }

    kernel
}

impl<S: Source<Item = f32>> Iterator for ResampleSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.pending_pos < self.pending.len() {
            let sample = self.pending[self.pending_pos];
            self.pending_pos += 1;
            return Some(sample);
        }

        let channels = self.channels.get() as usize;
        let half = (TAPS / 2) as i64;
        let t = self.out_frame as f64 * self.step;
        let n0 = t.floor() as i64;
        let frac = t - n0 as f64;
        let first = n0 - half + 1;
        let last = n0 + half;

        // Pull whole frames until the window is covered, or the input ends.
        while !self.eof && (self.next_frame as i64) <= last {
            for _ in 0..channels {
                match self.input.next() {
                    Some(sample) => self.history.push_back(sample),
                    None => {
                        self.eof = true;
                        break;
                    }
                }
            }
            if !self.eof {
                self.next_frame += 1;
            }
        }

        // Once the window no longer overlaps real input, the tail is done.
        if self.eof && (self.next_frame == 0 || first > self.next_frame as i64 - 1) {
            return None;
        }

        // Drop frames that fell out of the window.
        if first > self.history_frame as i64 {
            let drop_frames = (first - self.history_frame as i64) as usize;
            let drop_samples = (drop_frames * channels).min(self.history.len());
            self.history.drain(..drop_samples);
            self.history_frame += (drop_samples / channels) as u64;
        }

        let phase = ((frac * PHASES as f64) as usize).min(PHASES - 1);
        let row = &self.kernel[phase * TAPS..(phase + 1) * TAPS];

        self.pending.clear();
        let history_frame = self.history_frame as i64;
        let pulled = self.next_frame as i64;
        for channel in 0..channels {
            let mut acc = 0.0f64;
            for (k, &weight) in row.iter().enumerate() {
                let frame = first + k as i64;
                // Zero-pad the leading edge (before local frame 0) and the tail
                // past the last real frame, so the filter fades in/out cleanly.
                let sample = if frame < history_frame || frame >= pulled {
                    0.0
                } else {
                    let index = (frame - history_frame) as usize * channels + channel;
                    self.history.get(index).copied().unwrap_or(0.0)
                };
                acc += sample as f64 * weight as f64;
            }
            self.pending.push(acc as f32);
        }

        self.out_frame += 1;
        self.pending_pos = 1;
        self.pending.first().copied()
    }
}

impl<S: Source<Item = f32>> Source for ResampleSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> ChannelCount {
        self.channels
    }

    fn sample_rate(&self) -> SampleRate {
        self.out_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        // Resampling changes the sample count, not the wall-clock duration.
        self.input.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.input.try_seek(pos)?;
        self.reset();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZero;

    struct TestSource {
        samples: Vec<f32>,
        channels: ChannelCount,
        rate: SampleRate,
        pos: usize,
    }

    impl TestSource {
        fn new(samples: Vec<f32>, rate: u32) -> Self {
            Self {
                samples,
                channels: NonZero::new(2).unwrap(),
                rate: NonZero::new(rate).unwrap(),
                pos: 0,
            }
        }
    }

    impl Iterator for TestSource {
        type Item = f32;

        fn next(&mut self) -> Option<f32> {
            let sample = self.samples.get(self.pos).copied();
            self.pos += 1;
            sample
        }
    }

    impl Source for TestSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }

        fn channels(&self) -> ChannelCount {
            self.channels
        }

        fn sample_rate(&self) -> SampleRate {
            self.rate
        }

        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    fn stereo_constant(frames: usize, value: f32) -> Vec<f32> {
        std::iter::repeat_n(value, frames * 2).collect()
    }

    #[test]
    fn reports_the_output_rate() {
        let src = ResampleSource::new(
            TestSource::new(stereo_constant(100, 0.0), 44_100),
            NonZero::new(48_000).unwrap(),
        );
        assert_eq!(src.sample_rate().get(), 48_000);
        assert_eq!(src.channels().get(), 2);
    }

    #[test]
    fn dc_level_is_preserved() {
        let frames = 4_800;
        let mut src = ResampleSource::new(
            TestSource::new(stereo_constant(frames, 1.0), 44_100),
            NonZero::new(48_000).unwrap(),
        );
        let out: Vec<f32> = (&mut src).take(9_600).collect();
        // Skip the leading edge; the steady state must sit exactly at unity.
        for &sample in &out[1_000..8_000] {
            assert!(
                (sample - 1.0).abs() < 5e-3,
                "dc level drifted: {sample}"
            );
        }
    }

    #[test]
    fn sine_amplitude_survives_resampling() {
        let in_rate = 44_100.0f64;
        let freq = 997.0f64;
        let frames = 22_050usize;
        let samples: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let value =
                    (2.0 * PI * freq * i as f64 / in_rate).sin() as f32 * 0.5;
                [value, value]
            })
            .collect();

        let mut src = ResampleSource::new(
            TestSource::new(samples, 44_100),
            NonZero::new(48_000).unwrap(),
        );
        let out: Vec<f32> = (&mut src).skip(2_000).take(8_000).collect();
        let mean_sq: f64 = out
            .iter()
            .map(|&sample| (sample as f64) * (sample as f64))
            .sum::<f64>()
            / out.len() as f64;
        let rms = mean_sq.sqrt();
        let expected = 0.5 / 2f64.sqrt();
        assert!(
            (rms - expected).abs() / expected < 0.02,
            "rms {rms} vs expected {expected}"
        );
    }

    #[test]
    fn high_frequency_tone_is_not_dulled() {
        // rodio's linear interpolator loses ~3.4 dB at 15 kHz; the windowed
        // sinc must keep it within a fraction of a dB.
        let in_rate = 44_100.0f64;
        let freq = 15_000.0f64;
        let frames = 22_050usize;
        let samples: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let value = (2.0 * PI * freq * i as f64 / in_rate).sin() as f32 * 0.5;
                [value, value]
            })
            .collect();

        let mut src = ResampleSource::new(
            TestSource::new(samples, 44_100),
            NonZero::new(48_000).unwrap(),
        );
        let out: Vec<f32> = (&mut src).skip(4_000).take(8_000).collect();
        let mean_sq: f64 = out
            .iter()
            .map(|&sample| (sample as f64) * (sample as f64))
            .sum::<f64>()
            / out.len() as f64;
        let rms = mean_sq.sqrt();
        let expected = 0.5 / 2f64.sqrt();
        assert!(
            rms > expected * 0.97,
            "15 kHz tone dulled: rms {rms} vs expected {expected}"
        );
    }

    #[test]
    fn finite_input_terminates_with_a_short_tail() {
        let samples = stereo_constant(1_000, 0.25);
        let src = ResampleSource::new(
            TestSource::new(samples, 44_100),
            NonZero::new(48_000).unwrap(),
        );
        let frames = src.count() / 2;
        let expected = (1_000.0f64 * 48_000.0 / 44_100.0).round() as i64;
        assert!(
            (frames as i64 - expected).abs() < 64,
            "frames {frames} vs expected {expected}"
        );
    }

    #[test]
    fn downsample_stays_finite() {
        let samples: Vec<f32> = (0..4_800)
            .flat_map(|i| {
                let value = (i as f32 * 0.05).sin() * 0.7;
                [value, value]
            })
            .collect();
        let mut src = ResampleSource::new(
            TestSource::new(samples, 48_000),
            NonZero::new(44_100).unwrap(),
        );
        let out: Vec<f32> = (&mut src).collect();
        assert!(out.len() > 4_000);
        assert!(out.iter().all(|sample| sample.is_finite()));
    }
}
