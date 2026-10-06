import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { proxiedAssetUrl } from '../../lib/asset-url';
import { trackedInvoke as invoke } from '../../lib/diagnostics';
import { art, formatTime } from '../../lib/formatters';
import { useAddToPlaylist, useSearchTracks } from '../../lib/hooks';
import { Check, ListPlus, Loader2, Search, X } from '../../lib/icons';
import { type YtEntry, YOUTUBE_TRACK_PREFIX, ytEntryToTrack } from '../../lib/youtube';
import { useLocalPlaylistsStore } from '../../stores/local-playlists';
import { Modal, ModalClose, ModalContent, ModalTitle } from '../ui/Modal';

/** Where the picked tracks go: a SoundCloud playlist (backend delta) or a local
 *  YouTube/Spotify import (local store, played through yt-dlp). */
export type AddTracksTarget =
  | { kind: 'sc'; playlistUrn: string; existingUrns: Set<string> }
  | { kind: 'local'; playlistId: string; existingUrns: Set<string> };

const EMPTY_URNS: Set<string> = new Set();

function formatError(error: unknown): string {
  const raw =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

/** One selectable search result. */
const ResultRow = React.memo(function ResultRow({
  title,
  artist,
  artwork,
  durationSec,
  selected,
  disabled,
  onToggle,
}: {
  title: string;
  artist: string;
  artwork: string | null;
  durationSec: number;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all duration-200 ${
        disabled
          ? 'opacity-45 cursor-default'
          : selected
            ? 'bg-accent/12 ring-1 ring-accent/25 cursor-pointer'
            : 'hover:bg-white/[0.05] cursor-pointer'
      }`}
    >
      <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/[0.06] bg-white/[0.03]">
        {artwork ? (
          <img src={artwork} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ListPlus size={14} className="text-white/20" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-white/85 truncate">{title}</p>
        <p className="text-[11px] text-white/35 truncate">{artist}</p>
      </div>
      {durationSec > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-white/30">
          {formatTime(durationSec)}
        </span>
      )}
      {disabled ? (
        <span className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full bg-white/[0.06] text-white/45 border border-white/[0.06]">
          {t('playlist.alreadyAdded')}
        </span>
      ) : (
        <span
          className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center border transition-all ${
            selected ? 'bg-accent border-accent text-accent-contrast' : 'border-white/[0.14]'
          }`}
        >
          {selected && <Check size={12} />}
        </span>
      )}
    </button>
  );
});

const ListState = React.memo(function ListState({
  loading,
  error,
  hint,
}: {
  loading: boolean;
  error: string | null;
  hint: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-white/40 text-[12.5px]">
        <Loader2 size={15} className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3 my-2">
        <p className="text-[12px] text-red-300/90 break-words">{error}</p>
      </div>
    );
  }
  return <p className="py-10 text-center text-[12.5px] text-white/35">{hint}</p>;
});

export const AddTracksDialog = React.memo(function AddTracksDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  target: AddTracksTarget | null;
}) {
  const { t } = useTranslation();
  const isSc = target?.kind === 'sc';

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [ytEntries, setYtEntries] = useState<YtEntry[]>([]);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);

  const addToPlaylist = useAddToPlaylist();
  const sc = useSearchTracks(isSc ? debounced : '');

  // Fresh state for every open.
  useEffect(() => {
    if (open) return;
    setQuery('');
    setDebounced('');
    setSelected(new Set());
    setYtEntries([]);
    setYtError(null);
    setYtBusy(false);
  }, [open]);

  // SoundCloud search is debounced; YouTube search runs on submit (yt-dlp is heavy).
  useEffect(() => {
    if (!isSc) return;
    const timer = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [isSc, query]);

  const runYtSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setYtBusy(true);
    setYtError(null);
    setSelected(new Set());
    try {
      const entries = await invoke<YtEntry[]>('yt_search', { query: q, limit: 25 });
      setYtEntries(entries);
    } catch (error) {
      setYtError(formatError(error));
    } finally {
      setYtBusy(false);
    }
  }, [query]);

  const existing = target?.existingUrns ?? EMPTY_URNS;

  const toggle = useCallback((urn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(urn)) next.delete(urn);
      else next.add(urn);
      return next;
    });
  }, []);

  const handleAdd = useCallback(() => {
    if (!target || selected.size === 0) return;

    if (target.kind === 'sc') {
      const urns = [...selected];
      addToPlaylist.mutate(
        { playlistUrn: target.playlistUrn, trackUrns: urns },
        {
          onSuccess: () => {
            toast.success(t('playlist.tracksAdded', { count: urns.length }));
            onOpenChange(false);
          },
          onError: (error) => toast.error(formatError(error)),
        },
      );
      return;
    }

    const store = useLocalPlaylistsStore.getState();
    const playlist = store.playlists.find((p) => p.id === target.playlistId);
    if (!playlist) return;
    const present = new Set(playlist.tracks.map((tr) => tr.urn));
    const added = ytEntries
      .filter((entry) => selected.has(`${YOUTUBE_TRACK_PREFIX}${entry.id}`))
      .map((entry) => ytEntryToTrack(entry, playlist.uploader))
      .filter((track) => !present.has(track.urn));
    if (added.length === 0) {
      onOpenChange(false);
      return;
    }
    store.upsert({
      ...playlist,
      artworkUrl: playlist.artworkUrl ?? added[0]?.artwork_url ?? null,
      tracks: [...playlist.tracks, ...added],
    });
    toast.success(t('playlist.tracksAdded', { count: added.length }));
    onOpenChange(false);
  }, [target, selected, ytEntries, addToPlaylist, onOpenChange, t]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const scLoading = isSc && hasQuery && (sc.isLoading || trimmed !== debounced);
  const scEmpty = isSc && hasQuery && !scLoading && sc.tracks.length === 0;
  const ytEmpty = !isSc && hasQuery && !ytBusy && !ytError && ytEntries.length === 0;
  const busy = addToPlaylist.isPending;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="lg" showClose={false} zClass="z-[85]">
        <div className="px-7 pt-6 pb-4 border-b border-white/[0.06] flex items-center justify-between">
          <ModalTitle className="text-[18px] font-bold text-white/90 tracking-tight inline-flex items-center gap-2">
            <ListPlus size={18} className="text-white/70" />
            {t('playlist.addTracks')}
          </ModalTitle>
          <ModalClose asChild>
            <button
              type="button"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/[0.08] transition-all cursor-pointer"
            >
              <X size={16} />
            </button>
          </ModalClose>
        </div>

        <div className="px-7 py-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="relative flex-1">
              <Search
                size={15}
                className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSc) void runYtSearch();
                }}
                placeholder={isSc ? t('playlist.searchSc') : t('playlist.searchYt')}
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none"
              />
            </div>
            {!isSc && (
              <button
                type="button"
                onClick={() => void runYtSearch()}
                disabled={!hasQuery || ytBusy}
                className="px-4 py-2.5 rounded-xl bg-accent/20 hover:bg-accent/30 text-[12.5px] font-semibold text-accent border border-accent/20 transition-all cursor-pointer disabled:opacity-30"
              >
                {t('common.search')}
              </button>
            )}
          </div>

          <div className="max-h-[46vh] min-h-[180px] overflow-y-auto -mx-1 px-1 space-y-0.5">
            {isSc ? (
              <>
                {!hasQuery && (
                  <ListState loading={false} error={null} hint={t('playlist.searchScHint')} />
                )}
                {(scLoading || scEmpty) && (
                  <ListState
                    loading={scLoading}
                    error={null}
                    hint={t('search.noResults')}
                  />
                )}
                {!scLoading &&
                  sc.tracks.map((track) => {
                    const urn = track.urn;
                    const disabled = existing.has(urn);
                    return (
                      <ResultRow
                        key={urn}
                        title={track.title}
                        artist={track.user?.username ?? ''}
                        artwork={art(track.artwork_url, 't200x200')}
                        durationSec={(track.duration ?? 0) / 1000}
                        selected={selected.has(urn)}
                        disabled={disabled}
                        onToggle={() => toggle(urn)}
                      />
                    );
                  })}
                {sc.hasNextPage && (
                  <button
                    type="button"
                    onClick={() => void sc.fetchNextPage()}
                    disabled={sc.isFetchingNextPage}
                    className="w-full py-2.5 rounded-xl text-[12px] font-medium text-white/45 hover:text-white/75 hover:bg-white/[0.05] transition-all cursor-pointer disabled:opacity-40"
                  >
                    {sc.isFetchingNextPage ? (
                      <Loader2 size={14} className="animate-spin inline" />
                    ) : (
                      t('playlist.loadMore')
                    )}
                  </button>
                )}
              </>
            ) : (
              <>
                {(ytBusy || ytError || ytEmpty || !hasQuery) && (
                  <ListState
                    loading={ytBusy}
                    error={ytError}
                    hint={ytEmpty ? t('search.noResults') : t('playlist.searchYtHint')}
                  />
                )}
                {!ytBusy &&
                  ytEntries.map((entry) => {
                    const urn = `${YOUTUBE_TRACK_PREFIX}${entry.id}`;
                    const disabled = existing.has(urn);
                    return (
                      <ResultRow
                        key={entry.id}
                        title={entry.title}
                        artist={entry.uploader ?? 'YouTube'}
                        artwork={proxiedAssetUrl(entry.thumbnail)}
                        durationSec={entry.durationSecs ?? 0}
                        selected={selected.has(urn)}
                        disabled={disabled}
                        onToggle={() => toggle(urn)}
                      />
                    );
                  })}
              </>
            )}
          </div>
        </div>

        <div className="px-7 py-4 border-t border-white/[0.06] flex items-center gap-3">
          <span className="text-[12px] text-white/35 tabular-nums">
            {t('playlist.selectedCount', { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={handleAdd}
            disabled={selected.size === 0 || busy}
            className="ml-auto px-5 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[13px] font-semibold text-accent border border-accent/20 transition-all cursor-pointer disabled:opacity-30"
          >
            {busy ? t('common.loading') : t('playlist.addSelected', { count: selected.size })}
          </button>
        </div>
      </ModalContent>
    </Modal>
  );
});
