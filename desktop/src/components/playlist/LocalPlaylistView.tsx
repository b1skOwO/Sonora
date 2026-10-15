import type { DragEndEvent } from '@dnd-kit/core';
import * as Dialog from '@radix-ui/react-dialog';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { proxiedAssetUrl } from '../../lib/asset-url';
import {
  AlertCircle,
  ChevronLeft,
  ListMusic,
  ListPlus,
  Play,
  pauseBlack20,
  Shuffle,
  Spotify,
  Trash2,
  X,
  Youtube,
} from '../../lib/icons';
import {
  type LocalPlaylist,
  localPlaylistSourceLabel,
  useLocalPlaylistsStore,
} from '../../stores/local-playlists';
import { type Track, usePlayerStore } from '../../stores/player';
import { usePlaylistArtwork } from '../../stores/playlist-artwork';
import { AddTracksDialog } from './AddTracksDialog';
import { PlaylistArtworkButton } from './PlaylistArtworkDialog';
import { SequenceList } from './SequenceList';

/** Playlist page for local playlists (imported from YouTube/Spotify or created
 *  in the app) — no backend involved. */
export const LocalPlaylistView = React.memo(function LocalPlaylistView({
  playlist,
}: {
  playlist: LocalPlaylist | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const tracks = playlist?.tracks ?? [];
  const artworkOverride = usePlaylistArtwork(playlist?.id);
  const sourceLabel = playlist ? localPlaylistSourceLabel(playlist.source) : 'YouTube';
  const SourceIcon =
    playlist?.source === 'spotify' ? Spotify : playlist?.source === 'sonora' ? ListMusic : Youtube;
  const [showAdd, setShowAdd] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const trackUrnSet = useMemo(() => new Set(tracks.map((tr) => tr.urn)), [tracks]);
  const isCurrent = usePlayerStore(
    (s) => s.isPlaying && !!s.currentTrack && tracks.some((tr) => tr.urn === s.currentTrack!.urn),
  );

  const handlePlayAll = useCallback(() => {
    if (tracks.length === 0) return;
    const st = usePlayerStore.getState();
    if (isCurrent) {
      st.pause();
      return;
    }
    st.play(tracks[0], tracks);
  }, [isCurrent, tracks]);

  const handleShuffle = useCallback(() => {
    if (tracks.length === 0) return;
    const st = usePlayerStore.getState();
    if (!st.shuffle) usePlayerStore.setState({ shuffle: true });
    st.play(tracks[Math.floor(Math.random() * tracks.length)], tracks);
  }, [tracks]);

  const updateTracks = useCallback(
    (next: Track[]) => {
      if (!playlist) return;
      useLocalPlaylistsStore.getState().upsert({ ...playlist, tracks: next });
    },
    [playlist],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = tracks.findIndex((tr) => tr.urn === active.id);
      const newIndex = tracks.findIndex((tr) => tr.urn === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = [...tracks];
      const [moved] = next.splice(oldIndex, 1);
      next.splice(newIndex, 0, moved);
      updateTracks(next);
    },
    [tracks, updateTracks],
  );

  const handleRemoveTrack = useCallback(
    (trackUrn: string) => {
      updateTracks(tracks.filter((tr) => tr.urn !== trackUrn));
      toast.success(t('playlist.trackRemoved'));
    },
    [tracks, updateTracks, t],
  );

  const handleDelete = useCallback(() => {
    if (!playlist) return;
    useLocalPlaylistsStore.getState().remove(playlist.id);
    toast.success(t('playlist.deleted'));
    navigate(-1);
  }, [playlist, navigate, t]);

  if (!playlist) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-4">
        <Youtube size={32} className="text-white/20" />
        <p className="text-white/40 text-sm">{t('common.empty')}</p>
      </div>
    );
  }

  return (
    <div className="relative min-h-full w-full">
      <div
        className="relative z-10 max-w-[1320px] mx-auto px-4 md:px-8 pt-5 pb-10 space-y-7"
        style={{ isolation: 'isolate' }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full text-white/55 hover:text-white hover:bg-white/[0.06] transition-all duration-200 cursor-pointer"
          aria-label={t('search.back')}
        >
          <ChevronLeft size={18} />
        </button>

        <section
          className="relative overflow-hidden rounded-[2.25rem] p-6 md:p-8"
          style={{
            border: '0.5px solid rgba(255,255,255,0.1)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.42)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div className="flex flex-col md:flex-row items-center md:items-end gap-6">
            <div className="w-[150px] h-[150px] md:w-[190px] md:h-[190px] rounded-[1.6rem] overflow-hidden bg-white/[0.04] border border-white/[0.06] shrink-0">
              {(artworkOverride ?? playlist.artworkUrl) ? (
                <img
                  src={proxiedAssetUrl(artworkOverride ?? playlist.artworkUrl) ?? ''}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <SourceIcon size={40} className="text-white/25" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1 text-center md:text-left">
              <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.24em] text-white/45">
                <SourceIcon size={12} /> {sourceLabel}
              </p>
              <h1 className="mt-2.5 text-[26px] md:text-[38px] font-black tracking-tight leading-[1.05] break-words text-white/95">
                {playlist.title}
              </h1>
              <p className="mt-2 text-[13px] text-white/45">
                {playlist.uploader ?? sourceLabel} ·{' '}
                {t('playlist.tracks', { count: tracks.length })}
              </p>
              <div className="mt-5 flex items-center justify-center md:justify-start gap-3">
                <button
                  type="button"
                  onClick={handlePlayAll}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-full font-bold text-[14px] cursor-pointer transition-transform duration-300 hover:scale-[1.04] active:scale-95"
                  style={{ background: 'var(--color-accent)', color: '#0a0a0c' }}
                >
                  {isCurrent ? (
                    pauseBlack20
                  ) : (
                    <Play size={18} fill="currentColor" strokeWidth={0} />
                  )}
                  {t('playlist.playAll')}
                </button>
                <button
                  type="button"
                  onClick={handleShuffle}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-full font-bold text-[14px] text-white/80 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] cursor-pointer transition-all"
                >
                  <Shuffle size={17} />
                  {t('playlist.shuffle')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-full font-bold text-[14px] text-white/80 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] cursor-pointer transition-all"
                >
                  <ListPlus size={17} />
                  {t('playlist.addTracks')}
                </button>
                {playlist && <PlaylistArtworkButton urn={playlist.id} tracks={tracks} />}
                {playlist && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    title={t('playlist.delete')}
                    aria-label={t('playlist.delete')}
                    className="inline-flex items-center justify-center w-11 h-11 rounded-full text-white/45 bg-white/[0.06] hover:text-red-300 hover:bg-red-500/[0.12] border border-white/[0.08] hover:border-red-500/25 cursor-pointer transition-all"
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <SequenceList
          tracks={tracks}
          isOwner
          onDragEnd={handleDragEnd}
          onRemove={handleRemoveTrack}
          sentinelRef={sentinelRef}
          hasNextPage={false}
          isFetchingNextPage={false}
        />
      </div>

      <AddTracksDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        target={
          playlist ? { kind: 'local', playlistId: playlist.id, existingUrns: trackUrnSet } : null
        }
      />

      <Dialog.Root open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-fade-in" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[380px] rounded-2xl glass border border-white/[0.08] shadow-2xl animate-fade-in-up p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
                <AlertCircle size={20} className="text-red-400" />
              </div>
              <Dialog.Title className="text-[15px] font-bold text-white/90">
                {t('playlist.delete')}
              </Dialog.Title>
              <Dialog.Close className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-all">
                <X size={14} />
              </Dialog.Close>
            </div>
            <p className="text-[13px] text-white/50 leading-relaxed">
              {t('playlist.deleteConfirm', { title: playlist.title })}
            </p>
            <div className="flex items-center justify-end gap-2.5 pt-1">
              <Dialog.Close className="px-4 py-2 rounded-xl text-[13px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.06] transition-all cursor-pointer">
                {t('common.cancel')}
              </Dialog.Close>
              <button
                type="button"
                onClick={handleDelete}
                className="px-4 py-2 rounded-xl text-[13px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-all cursor-pointer"
              >
                {t('playlist.delete')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
});
