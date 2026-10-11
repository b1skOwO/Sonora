import { useQuery } from '@tanstack/react-query';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Track } from '../stores/player';

export interface WaveformSamples {
  /** Packed u8 amplitudes (0..height) — 8× smaller than a parsed number[]. */
  values: Uint8Array;
  height: number;
}

interface ScWaveformJson {
  width: number;
  height: number;
  samples: number[];
}

/** Convert SC's PNG waveform URL (`_m.png`) to the JSON variant (`_m.json`). */
function normalizeWaveformUrl(raw: string): string | null {
  if (!raw) return null;
  // Modern field: "https://wave.sndcdn.com/XXXX_m.png" → swap extension to .json.
  // Legacy field already ends in .json.
  return raw.replace(/\.png(\?.*)?$/i, '.json$1').replace(/^http:\/\//i, 'https://');
}

async function fetchWaveform(rawUrl: string): Promise<WaveformSamples> {
  const url = normalizeWaveformUrl(rawUrl);
  if (!url) throw new Error('Invalid waveform url');

  const res = await tauriFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`waveform ${res.status}`);
  const json = (await res.json()) as ScWaveformJson;

  if (!Array.isArray(json.samples) || json.samples.length === 0) {
    throw new Error('waveform: empty samples');
  }
  // Samples are small integers (0..height); pack them so the react-query cache
  // holds bytes, not boxed numbers.
  const values = Uint8Array.from(json.samples, (value) =>
    Math.max(0, Math.min(255, Math.round(value))),
  );
  return { values, height: json.height || 140 };
}

/** Fetch + cache a track's raw SC waveform JSON. 15-min cache per track URN. */
export function useTrackWaveform(track: Track | null) {
  const rawUrl = track?.waveform_url ?? null;
  return useQuery({
    queryKey: ['waveform', rawUrl],
    enabled: !!rawUrl,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 15,
    retry: false,
    queryFn: () => fetchWaveform(rawUrl!),
  });
}
