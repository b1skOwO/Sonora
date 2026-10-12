import type { DragEndEvent } from '@dnd-kit/core';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { proxiedAssetUrl } from '../../lib/asset-url';
import {
  ChevronLeft,
  ListPlus,
  Play,
  pauseBlack20,
  Shuffle,
  Spotify,
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

/** Playlist page for locally imported YouTube playlists — no backend involved. */
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
  const SourceIcon = playlist?.source === 'spotify' ? Spotify : Youtube;
  const [showAdd, setShowAdd] = useState(false);
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
    </div>
  );
});
