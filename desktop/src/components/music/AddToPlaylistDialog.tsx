import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fc } from '../../lib/formatters';
import {
  type Playlist,
  useAddToPlaylist,
  useCreatePlaylist,
  useMyPlaylists,
} from '../../lib/hooks';
import { Globe, ListMusic, ListPlus, Loader2, Lock, Plus, X } from '../../lib/icons';
import { getOfflineTracksByUrns } from '../../lib/offline-index';
import { playlistCoverUrl } from '../../lib/playlist-cover';
import { isYoutubeUrn } from '../../lib/youtube';
import { localPlaylistToCard, useLocalPlaylistsStore } from '../../stores/local-playlists';
import { type Track, usePlayerStore } from '../../stores/player';
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalTitle,
  ModalTrigger,
} from '../ui/Modal';

interface AddToPlaylistDialogProps {
  trackUrns: string[];
  /** Full track objects — required to append YouTube tracks to local playlists. */
  tracks?: Track[];
  children: React.ReactNode;
}

function formatError(error: unknown): string {
  const raw =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

const PlaylistOption = React.memo(function PlaylistOption({
  playlist,
  onSelect,
  loading,
  containsAll,
  containsSome,
}: {
  playlist: Playlist;
  onSelect: (p: Playlist) => void;
  loading: boolean;
  containsAll: boolean;
  containsSome: boolean;
}) {
  const { t } = useTranslation();
  const cover = playlistCoverUrl(playlist.artwork_url, playlist.tracks, 'small');

  return (
    <button
      type="button"
      onClick={() => onSelect(playlist)}
      disabled={loading || containsAll}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-left disabled:opacity-50 ${
        containsAll ? 'bg-white/[0.04]' : 'hover:bg-white/[0.06]'
      }`}
    >
      <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 ring-1 ring-white/[0.06] bg-white/[0.03]">
        {cover ? (
          <img src={cover} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ListMusic size={14} className="text-white/20" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-white/85 truncate">{playlist.title}</p>
        <p className="text-[11px] text-white/30">{fc(playlist.track_count)} tracks</p>
      </div>
      {containsAll ? (
        <span className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full bg-accent/12 text-accent border border-accent/20">
          {t('playlist.alreadyAdded')}
        </span>
      ) : containsSome ? (
        <span className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full bg-white/[0.06] text-white/55 border border-white/[0.06]">
          {t('playlist.containsSome')}
        </span>
      ) : null}
      {playlist.sharing === 'private' && <Lock size={12} className="text-white/20 shrink-0" />}
    </button>
  );
});

/* ── Inline Create Form ──────────────────────────────────────── */

const CreatePlaylistForm = React.memo(function CreatePlaylistForm({
  trackUrns,
  onCreated,
}: {
  trackUrns: string[];
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const createPlaylist = useCreatePlaylist();

  const handleSubmit = useCallback(() => {
    const title = name.trim();
    if (!title) return;
    createPlaylist.mutate(
      { title, sharing: isPrivate ? 'private' : 'public', trackUrns },
      {
        onSuccess: () => {
          toast.success(t('playlist.created'));
          onCreated();
        },
      },
    );
  }, [name, isPrivate, trackUrns, createPlaylist, onCreated, t]);

  return (
    <div className="px-3 pb-3">
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 space-y-2.5">
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder={t('playlist.playlistName')}
          className="w-full bg-white/[0.04] text-[13px] text-white/90 placeholder:text-white/25 px-3 py-2 rounded-lg outline-none border border-white/[0.06] focus:border-accent/30 transition-colors"
          autoFocus
          disabled={createPlaylist.isPending}
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsPrivate((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/60 transition-colors cursor-pointer"
          >
            {isPrivate ? <Lock size={12} /> : <Globe size={12} />}
            {isPrivate ? t('playlist.private') : t('playlist.public')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!name.trim() || createPlaylist.isPending}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            {createPlaylist.isPending ? t('playlist.creating') : t('playlist.create')}
          </button>
        </div>
      </div>
    </div>
  );
});

/* ── Main Dialog ─────────────────────────────────────────────── */

export const AddToPlaylistDialog = React.memo(function AddToPlaylistDialog({
  trackUrns,
  tracks,
  children,
}: AddToPlaylistDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const { playlists, isLoading } = useMyPlaylists();
  const localPlaylists = useLocalPlaylistsStore((s) => s.playlists);
  const addToPlaylist = useAddToPlaylist();
  const [playlistTrackMap, setPlaylistTrackMap] = useState<Record<string, string[]>>({});
  const [loadingPlaylistUrns, setLoadingPlaylistUrns] = useState<Record<string, boolean>>({});
  const normalizedTrackUrns = useMemo(() => [...new Set(trackUrns)], [trackUrns]);

  // YouTube tracks can't go to backend playlists — they land in local imports.
  const isLocalMode =
    normalizedTrackUrns.length > 0 && normalizedTrackUrns.every((urn) => isYoutubeUrn(urn));
  const trackByUrn = useMemo(() => {
    const map = new Map<string, Track>();
    for (const track of tracks ?? []) map.set(track.urn, track);
    return map;
  }, [tracks]);

  // Membership ("already in this playlist") is resolved lazily per playlist on
  // select — never fanned out for every playlist on open. The bulk fetch used
  // to stall the dialog for seconds on slow backends and left every row
  // disabled (untappable) while loading.

  /** Track URNs of one backend playlist: embedded data, a cached fetch, or one
   *  fetch now. `null` when even the fetch failed — the backend dedupes `{add}`
   *  deltas, so an unknown membership still adds safely. */
  const ensurePlaylistUrns = async (playlist: Playlist): Promise<string[] | null> => {
    const embedded = playlist.tracks?.map((t) => t.urn) ?? [];
    if (embedded.length > 0 || playlist.track_count === 0) return embedded;
    const cached = playlistTrackMap[playlist.urn];
    if (cached) return cached;
    setLoadingPlaylistUrns((prev) => ({ ...prev, [playlist.urn]: true }));
    try {
      const res = await api<{ collection: { urn: string }[] }>(
        `/playlists/${encodeURIComponent(playlist.urn)}/tracks?limit=200`,
      );
      const urns = res.collection.map((t) => t.urn);
      setPlaylistTrackMap((prev) => ({ ...prev, [playlist.urn]: urns }));
      return urns;
    } catch {
      return null;
    } finally {
      setLoadingPlaylistUrns((prev) => ({ ...prev, [playlist.urn]: false }));
    }
  };

  const playlistMembership = useMemo(() => {
    const entries = new Map<string, { containsAll: boolean; containsSome: boolean }>();

    for (const playlist of playlists) {
      const existingUrns =
        playlistTrackMap[playlist.urn] ?? playlist.tracks?.map((t) => t.urn) ?? [];
      const existingSet = new Set(existingUrns);
      const matchedCount = normalizedTrackUrns.filter((urn) => existingSet.has(urn)).length;
      entries.set(playlist.urn, {
        containsAll: normalizedTrackUrns.length > 0 && matchedCount === normalizedTrackUrns.length,
        containsSome: matchedCount > 0 && matchedCount < normalizedTrackUrns.length,
      });
    }

    return entries;
  }, [playlists, playlistTrackMap, normalizedTrackUrns]);

  const handleSelect = async (playlist: Playlist) => {
    // `{add}`-deltas; the backend dedupes, so an unknown membership (failed
    // fetch) still adds safely instead of claiming "already in".
    // YouTube URN'ы в backend-дельты не шлём — бэкенд их не резолвит.
    const existing = await ensurePlaylistUrns(playlist);
    const existingSet = existing ? new Set(existing) : null;
    const newUrns = trackUrns.filter((u) => !existingSet?.has(u) && !isYoutubeUrn(u));

    if (existingSet && newUrns.length === 0) {
      toast.info(t('playlist.alreadyInPlaylist'));
      setOpen(false);
      return;
    }

    addToPlaylist.mutate(
      { playlistUrn: playlist.urn, trackUrns: newUrns },
      {
        onSuccess: () => {
          if (existing) {
            setPlaylistTrackMap((prev) => ({
              ...prev,
              [playlist.urn]: [...existing, ...newUrns],
            }));
          }
          toast.success(t('playlist.addedToPlaylist'));
          setOpen(false);
        },
        onError: (error) => toast.error(formatError(error)),
      },
    );
  };

  const handleSelectLocal = useCallback(
    async (playlistId: string) => {
      const store = useLocalPlaylistsStore.getState();
      const playlist = store.playlists.find((p) => p.id === playlistId);
      if (!playlist) return;
      const present = new Set(playlist.tracks.map((tr) => tr.urn));
      // Callers don't always pass full Track objects — resolve the missing
      // ones from the player queue, then the offline track index.
      const resolved = new Map(trackByUrn);
      const missing = normalizedTrackUrns.filter((urn) => !present.has(urn) && !resolved.has(urn));
      if (missing.length > 0) {
        const queue = usePlayerStore.getState().queue;
        for (const track of queue) {
          if (!resolved.has(track.urn)) resolved.set(track.urn, track);
        }
        const stillMissing = missing.filter((urn) => !resolved.has(urn));
        if (stillMissing.length > 0) {
          try {
            for (const track of await getOfflineTracksByUrns(stillMissing)) {
              resolved.set(track.urn, track);
            }
          } catch {
            // Unresolvable tracks are skipped below.
          }
        }
      }
      const added = normalizedTrackUrns
        .map((urn) => resolved.get(urn))
        .filter((tr): tr is Track => !!tr && !present.has(tr.urn));
      if (added.length === 0) {
        toast.info(t('playlist.alreadyInPlaylist'));
        setOpen(false);
        return;
      }
      store.upsert({
        ...playlist,
        artworkUrl: playlist.artworkUrl ?? added[0]?.artwork_url ?? null,
        tracks: [...playlist.tracks, ...added],
      });
      toast.success(t('playlist.addedToPlaylist'));
      setOpen(false);
    },
    [normalizedTrackUrns, trackByUrn, t],
  );

  const localMembership = useMemo(() => {
    const entries = new Map<string, { containsAll: boolean; containsSome: boolean }>();
    for (const playlist of localPlaylists) {
      const existingSet = new Set(playlist.tracks.map((tr) => tr.urn));
      const matchedCount = normalizedTrackUrns.filter((urn) => existingSet.has(urn)).length;
      entries.set(playlist.id, {
        containsAll: normalizedTrackUrns.length > 0 && matchedCount === normalizedTrackUrns.length,
        containsSome: matchedCount > 0 && matchedCount < normalizedTrackUrns.length,
      });
    }
    return entries;
  }, [localPlaylists, normalizedTrackUrns]);

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) setShowCreate(false);
  };

  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalTrigger asChild>{children}</ModalTrigger>
      <ModalContent size="sm" showClose={false} zClass="z-[90]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <ModalTitle className="text-[15px] font-bold text-white/90 flex items-center gap-2">
            <ListPlus size={18} />
            {t('playlist.addToPlaylist')}
          </ModalTitle>
          <ModalDescription className="sr-only">
            Choose a playlist for the selected track.
          </ModalDescription>
          <ModalClose className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-all">
            <X size={14} />
          </ModalClose>
        </div>

        {/* New playlist button / form (SoundCloud playlists only —
              YouTube tracks can't go to backend playlists) */}
        {!isLocalMode &&
          (showCreate ? (
            <CreatePlaylistForm
              trackUrns={trackUrns}
              onCreated={() => {
                setShowCreate(false);
                setOpen(false);
              }}
            />
          ) : (
            <div className="px-3 pb-2">
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.06] transition-all duration-200 text-left"
              >
                <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent/10 ring-1 ring-accent/20">
                  <Plus size={18} className="text-accent" />
                </div>
                <span className="text-[13px] font-medium text-accent">
                  {t('playlist.newPlaylist')}
                </span>
              </button>
            </div>
          ))}

        {/* Divider */}
        {!isLocalMode && <div className="h-px bg-white/[0.04] mx-5" />}

        {/* Playlist list */}
        <div className="px-3 py-2 pb-4 overflow-y-auto flex-1 min-h-0">
          {isLocalMode ? (
            localPlaylists.length === 0 ? (
              <div className="py-10 text-center text-[13px] text-white/25">
                {t('playlist.noPlaylists')}
              </div>
            ) : (
              <div className="space-y-0.5">
                {localPlaylists.map((p) => (
                  <PlaylistOption
                    key={p.id}
                    playlist={localPlaylistToCard(p)}
                    onSelect={() => handleSelectLocal(p.id)}
                    loading={addToPlaylist.isPending}
                    containsAll={localMembership.get(p.id)?.containsAll ?? false}
                    containsSome={localMembership.get(p.id)?.containsSome ?? false}
                  />
                ))}
              </div>
            )
          ) : isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={20} className="animate-spin text-white/20" />
            </div>
          ) : playlists.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-white/25">
              {t('playlist.noPlaylists')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {playlists.map((p) => (
                <PlaylistOption
                  key={p.urn}
                  playlist={p}
                  onSelect={handleSelect}
                  loading={addToPlaylist.isPending || !!loadingPlaylistUrns[p.urn]}
                  containsAll={playlistMembership.get(p.urn)?.containsAll ?? false}
                  containsSome={playlistMembership.get(p.urn)?.containsSome ?? false}
                />
              ))}
            </div>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
});
