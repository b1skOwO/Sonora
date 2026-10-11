import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { proxiedAssetUrl } from '../../lib/asset-url';
import { trackedInvoke as invoke } from '../../lib/diagnostics';
import { formatTime } from '../../lib/formatters';
import { ListPlus, Loader2, Play, Search, Youtube } from '../../lib/icons';
import { type YtEntry, ytEntryToTrack } from '../../lib/youtube';
import { type Track, usePlayerStore } from '../../stores/player';
import { useSearchQueryStore } from '../../stores/searchQuery';
import { AddToPlaylistDialog } from '../music/AddToPlaylistDialog';

function formatError(error: unknown): string {
  const raw =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

const YtRow = React.memo(function YtRow({
  track,
  queue,
  artwork,
  durationSec,
}: {
  track: Track;
  queue: Track[];
  artwork: string | null;
  durationSec: number;
}) {
  const { t } = useTranslation();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isCurrent = currentTrack?.urn === track.urn;

  const handlePlay = () => {
    const st = usePlayerStore.getState();
    if (isCurrent) {
      if (isPlaying) st.pause();
      else st.resume();
      return;
    }
    st.play(track, queue);
  };

  return (
    <div className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all duration-200 hover:bg-white/[0.05]">
      <button
        type="button"
        onClick={handlePlay}
        className="flex flex-1 min-w-0 items-center gap-3 cursor-pointer"
      >
        <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/[0.06] bg-white/[0.03]">
          {artwork ? (
            <img src={artwork} alt="" className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Youtube size={16} className="text-white/20" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-white/85 truncate">{track.title}</p>
          <p className="text-[11px] text-white/35 truncate">{track.user?.username ?? ''}</p>
        </div>
        {durationSec > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-white/30">
            {formatTime(durationSec)}
          </span>
        )}
        <span
          className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
            isCurrent && isPlaying
              ? 'bg-[var(--color-accent)] text-accent-contrast'
              : 'bg-white/[0.06] text-white/70'
          }`}
        >
          <Play size={13} fill="currentColor" strokeWidth={0} />
        </span>
      </button>
      <AddToPlaylistDialog trackUrns={[track.urn]} tracks={[track]}>
        <button
          type="button"
          title={t('playlist.addToPlaylist')}
          aria-label={t('playlist.addToPlaylist')}
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white/35 hover:text-white/80 hover:bg-white/[0.07] transition-all cursor-pointer"
        >
          <ListPlus size={15} />
        </button>
      </AddToPlaylistDialog>
    </div>
  );
});

/** YouTube-mode search: query → yt-dlp `ytsearch` → playable rows. The query
 *  comes from the same global header field as SoundCloud search. */
export const YoutubeSearchPane = React.memo(function YoutubeSearchPane() {
  const { t } = useTranslation();
  const q = useSearchQueryStore((s) => s.q);
  const [entries, setEntries] = useState<YtEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState('');

  const run = useCallback(async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await invoke<YtEntry[]>('yt_search', { query, limit: 25 });
      setEntries(found);
      setSearched(query);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, [q, busy]);

  const tracks = entries.map((e) => ytEntryToTrack(e));

  return (
    <div className="max-w-[860px] mx-auto w-full px-4 pb-10">
      <div className="flex items-center gap-2.5 mb-4">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center bg-white/[0.05] ring-1 ring-white/[0.08]">
          <Youtube size={17} className="text-white/75" />
        </span>
        <div>
          <h2 className="text-[16px] font-bold text-white/90 tracking-tight">
            {t('search.youtubeTitle')}
          </h2>
          <p className="text-[11.5px] text-white/35">{t('search.youtubeHint')}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={!q.trim() || busy}
          className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[12.5px] font-semibold text-accent border border-accent/20 transition-all cursor-pointer disabled:opacity-30"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {t('common.search')}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3 mb-3">
          <p className="text-[12px] text-red-300/90 break-words">{error}</p>
        </div>
      )}

      {!busy && entries.length === 0 && !error && (
        <p className="py-14 text-center text-[12.5px] text-white/35">
          {searched ? t('search.noResults') : t('search.youtubeEmpty')}
        </p>
      )}

      <div className="space-y-0.5">
        {tracks.map((track, i) => (
          <YtRow
            key={track.urn}
            track={track}
            queue={tracks}
            artwork={proxiedAssetUrl(entries[i]?.thumbnail)}
            durationSec={entries[i]?.durationSecs ?? 0}
          />
        ))}
      </div>
    </div>
  );
});
