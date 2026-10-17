import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Aura } from '../../lib/aura';
import { fc } from '../../lib/formatters';
import type { Playlist } from '../../lib/hooks';
import {
  useInfiniteScroll,
  useSearchDbPlaylists,
  useSearchDbTracks,
  useUserFollowers,
  useUserFollowings,
  useUserLikedTracks,
  useUserPlaylists,
  useUserPopularTracks,
  useUserTracks,
} from '../../lib/hooks';
import { Loader2, Music } from '../../lib/icons';
import { usePerfMode } from '../../lib/perf';
import {
  importPublicLikesPlaylist,
  importPublicPlaylist,
  loadImportedLikesPlaylists,
  loadImportedPublicPlaylists,
  saveImportedLikesPlaylist,
  saveImportedPublicPlaylist,
} from '../../lib/public-sc';
import { PlaylistCard } from '../music/PlaylistCard';
import { Avatar } from '../ui/Avatar';
import { VirtualGrid } from '../ui/VirtualGrid';
import { VirtualList } from '../ui/VirtualList';
import { ThemedTrackRow } from './ThemedTrackRow';

interface TabWrapperProps {
  isLoading: boolean;
  isEmpty: boolean;
  error?: unknown;
  emptyText?: string;
  syncPending?: boolean;
  onRetrySync?: () => void;
  children: React.ReactNode;
}

function TabWrapperImpl({
  children,
  isLoading,
  isEmpty,
  error,
  emptyText,
  syncPending = false,
  onRetrySync,
}: TabWrapperProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-[420px]">
      {isLoading ? (
        <div className="py-24 flex justify-center">
          <Loader2 size={28} className="text-white/20 animate-spin" />
        </div>
      ) : error ? (
        <div className="py-24 flex flex-col items-center gap-3 text-center">
          <p className="text-white/55 text-sm">{t('common.error')}</p>
          <p className="max-w-xl break-words text-white/30 text-xs">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      ) : syncPending ? (
        <div className="py-24 flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-white/45 text-sm">{t('user.syncPending')}</p>
          <button
            type="button"
            onClick={onRetrySync}
            className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-medium text-white/65 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : isEmpty ? (
        <div className="py-24 flex flex-col items-center gap-4">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '0.5px solid rgba(255,255,255,0.06)',
            }}
          >
            <Music size={24} className="text-white/15" />
          </div>
          <p className="text-white/30 text-sm">{emptyText ?? t('common.empty')}</p>
        </div>
      ) : (
        <div className="animate-in fade-in duration-500">{children}</div>
      )}
    </div>
  );
}

export const TabWrapper = React.memo(TabWrapperImpl);

function useSyncTimeout(isSyncing: boolean, retryEpoch: number) {
  const [timedOut, setTimedOut] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryEpoch restarts the timeout on manual retry
  useEffect(() => {
    setTimedOut(false);
    if (!isSyncing) return;
    const timer = setTimeout(() => setTimedOut(true), 60_000);
    return () => clearTimeout(timer);
  }, [isSyncing, retryEpoch]);

  return timedOut;
}

export function UserTracksTab({ urn, aura }: { urn: string; aura: Aura }) {
  const q = useUserTracks(urn);
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);
  const renderItem = useCallback(
    (track: (typeof q.tracks)[number], i: number) => (
      <ThemedTrackRow track={track} index={i} queue={q.tracks} aura={aura} />
    ),
    [aura, q.tracks],
  );
  return (
    <TabWrapper isLoading={q.isLoading} isEmpty={q.tracks.length === 0}>
      <VirtualList
        items={q.tracks}
        rowHeight={72}
        overscan={8}
        className="flex flex-col gap-1"
        getItemKey={(t) => t.urn}
        renderItem={renderItem}
      />
      <div ref={ref} className="h-16 flex items-center justify-center">
        {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
      </div>
    </TabWrapper>
  );
}

export function UserPopularTab({ urn, aura }: { urn: string; aura: Aura }) {
  const { data = [], isLoading } = useUserPopularTracks(urn);
  const renderItem = useCallback(
    (track: (typeof data)[number], i: number) => (
      <ThemedTrackRow track={track} index={i} queue={data} aura={aura} />
    ),
    [aura, data],
  );
  return (
    <TabWrapper isLoading={isLoading} isEmpty={data.length === 0}>
      <VirtualList
        items={data}
        rowHeight={72}
        overscan={8}
        className="flex flex-col gap-1"
        getItemKey={(t) => t.urn}
        renderItem={renderItem}
      />
    </TabWrapper>
  );
}

export function UserPlaylistsTab({ urn }: { urn: string }) {
  const q = useUserPlaylists(urn);
  const { t } = useTranslation();
  const [playlistLink, setPlaylistLink] = useState('');
  const [importedPlaylists, setImportedPlaylists] = useState(loadImportedPublicPlaylists);
  const [importing, setImporting] = useState(false);
  const isSyncing =
    (q.data?.pages.some((page) => page.sync?.status === 'refreshing') ?? false) &&
    q.playlists.length === 0;
  const [retryEpoch, setRetryEpoch] = useState(0);
  const syncTimedOut = useSyncTimeout(isSyncing, retryEpoch);
  const syncPending = isSyncing && syncTimedOut;
  const retrySync = () => {
    setRetryEpoch((epoch) => epoch + 1);
    q.retrySync();
  };
  const importLink = async (event: React.FormEvent) => {
    event.preventDefault();
    setImporting(true);
    try {
      const playlist = await importPublicPlaylist(playlistLink);
      setImportedPlaylists(saveImportedPublicPlaylist(playlist));
      setPlaylistLink('');
      toast.success(t('user.playlistImported', { title: playlist.title }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not import this playlist');
    } finally {
      setImporting(false);
    }
  };
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);
  const renderItem = useCallback(
    (p: (typeof q.playlists)[number]) => <PlaylistCard playlist={p} showPlayback />,
    [],
  );
  return (
    <>
      <form
        onSubmit={importLink}
        className="mb-5 flex w-full gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="url"
          value={playlistLink}
          onChange={(event) => setPlaylistLink(event.target.value)}
          placeholder={t('user.playlistImportPlaceholder')}
          aria-label={t('user.playlistImportPlaceholder')}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/25"
        />
        <button
          type="submit"
          disabled={importing || !playlistLink.trim()}
          className="shrink-0 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {importing ? <Loader2 size={16} className="animate-spin" /> : t('user.importPlaylist')}
        </button>
      </form>
      <TabWrapper
        isLoading={importedPlaylists.length === 0 && (q.isLoading || (isSyncing && !syncPending))}
        isEmpty={q.playlists.length === 0 && importedPlaylists.length === 0}
        error={importedPlaylists.length === 0 ? q.error : undefined}
        syncPending={importedPlaylists.length === 0 && syncPending}
        onRetrySync={retrySync}
      >
        <VirtualGrid
          items={[
            ...importedPlaylists,
            ...q.playlists.filter(
              (item) => !importedPlaylists.some((imported) => imported.id === item.id),
            ),
          ]}
          itemHeight={320}
          minColumnWidth={200}
          gap={28}
          overscan={3}
          getItemKey={(p, i) => `${p.urn}-${i}`}
          renderItem={renderItem}
        />
        <div ref={ref} className="h-16 flex items-center justify-center">
          {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
        </div>
      </TabWrapper>
    </>
  );
}

/** Does an imported likes snapshot belong to the profile being viewed? Route
 *  urns are usually `soundcloud:users:{id}`; a digits-only urn also binds.
 *  Permalink-shaped urns cannot be matched — the live list stays there. */
function likesForProfile(profileUrn: string | undefined, playlist: Playlist): boolean {
  if (!profileUrn) return false;
  const id = profileUrn.match(/users:(\d+)/)?.[1] ?? (/^\d+$/.test(profileUrn) ? profileUrn : null);
  if (!id) return false;
  return String(playlist.user.id) === id;
}

export function UserLikesTab({ urn, aura }: { urn: string; aura: Aura }) {
  const q = useUserLikedTracks(urn);
  const { t } = useTranslation();
  const [accountLink, setAccountLink] = useState('');
  // Imported like snapshots persist across sessions. On mount, only pick up
  // snapshots that belong to the profile being viewed — a snapshot made for
  // another account must not leak into this profile's live like list.
  const [likesPlaylists, setLikesPlaylists] = useState(loadImportedLikesPlaylists);
  const [likesPlaylist, setLikesPlaylist] = useState<Awaited<
    ReturnType<typeof importPublicLikesPlaylist>
  > | null>(() => likesPlaylists.find((playlist) => likesForProfile(urn, playlist)) ?? null);
  const [importing, setImporting] = useState(false);
  const importAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setImporting(true);
    try {
      const playlist = await importPublicLikesPlaylist(accountLink);
      // Persist the snapshot — without it the playlist page would hit the
      // backend with the local `imported-likes-` urn and get a 400.
      setLikesPlaylists(saveImportedLikesPlaylist(playlist));
      setLikesPlaylist(playlist);
      setAccountLink('');
      toast.success(
        t('user.likesImported', { count: playlist.track_count, title: playlist.title }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not import account likes');
    } finally {
      setImporting(false);
    }
  };
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);
  const tracks = likesPlaylist ? likesPlaylist.tracks : q.tracks;
  const renderItem = useCallback(
    (track: (typeof tracks)[number], i: number) => (
      <ThemedTrackRow track={track} index={i} queue={tracks} aura={aura} />
    ),
    [aura, tracks],
  );
  return (
    <>
      <form
        onSubmit={importAccount}
        className="mb-5 flex w-full gap-2"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="url"
          value={accountLink}
          onChange={(event) => setAccountLink(event.target.value)}
          placeholder={t('user.likesImportPlaceholder')}
          aria-label={t('user.likesImportPlaceholder')}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-white/25"
        />
        <button
          type="submit"
          disabled={importing || !accountLink.trim()}
          className="shrink-0 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white/80 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {importing ? <Loader2 size={16} className="animate-spin" /> : t('user.importLikes')}
        </button>
      </form>
      {likesPlaylists.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-3">
          {likesPlaylists.map((playlist) => (
            <div key={playlist.urn} className="max-w-[240px]">
              <PlaylistCard playlist={playlist} showPlayback />
            </div>
          ))}
        </div>
      )}
      <TabWrapper
        isLoading={!likesPlaylist && q.isLoading}
        isEmpty={tracks.length === 0}
        error={likesPlaylist ? undefined : q.error}
      >
        <VirtualList
          items={tracks}
          rowHeight={72}
          overscan={8}
          className="flex flex-col gap-1"
          getItemKey={(t) => t.urn}
          renderItem={renderItem}
        />
        <div ref={ref} className="h-16 flex items-center justify-center">
          {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
        </div>
      </TabWrapper>
    </>
  );
}

/**
 * Поиск треков юзера в нашей базе (`/search/db/tracks?user_urn=...`). Идёт
 * только локально — на SC нет API "tracks этого юзера с подстрочным q=".
 * Рендер совместим с обычным UserTracksTab, чтобы UI не "прыгал" при
 * включении/выключении поиска.
 */
export function UserSearchTracksTab({
  urn,
  aura,
  query,
}: {
  urn: string;
  aura: Aura;
  query: string;
}) {
  const { t } = useTranslation();
  const q = useSearchDbTracks(query, urn);
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);
  const renderItem = useCallback(
    (track: (typeof q.tracks)[number], i: number) => (
      <ThemedTrackRow track={track} index={i} queue={q.tracks} aura={aura} />
    ),
    [aura, q.tracks],
  );
  return (
    <TabWrapper
      isLoading={q.isLoading}
      isEmpty={q.tracks.length === 0}
      emptyText={t('user.search.empty')}
    >
      <VirtualList
        items={q.tracks}
        rowHeight={72}
        overscan={8}
        className="flex flex-col gap-1"
        getItemKey={(t) => t.urn}
        renderItem={renderItem}
      />
      <div ref={ref} className="h-16 flex items-center justify-center">
        {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
      </div>
    </TabWrapper>
  );
}

/**
 * Поиск плейлистов юзера в нашей базе. Та же логика, что и Tracks-вариант.
 */
export function UserSearchPlaylistsTab({ urn, query }: { urn: string; query: string }) {
  const { t } = useTranslation();
  const q = useSearchDbPlaylists(query, urn);
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);
  const renderItem = useCallback(
    (p: (typeof q.playlists)[number]) => <PlaylistCard playlist={p} showPlayback />,
    [],
  );
  return (
    <TabWrapper
      isLoading={q.isLoading}
      isEmpty={q.playlists.length === 0}
      emptyText={t('user.search.empty')}
    >
      <VirtualGrid
        items={q.playlists}
        itemHeight={320}
        minColumnWidth={200}
        gap={28}
        overscan={3}
        getItemKey={(p, i) => `${p.urn}-${i}`}
        renderItem={renderItem}
      />
      <div ref={ref} className="h-16 flex items-center justify-center">
        {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
      </div>
    </TabWrapper>
  );
}

export function UserConnectionsTab({
  urn,
  mode,
}: {
  urn: string;
  mode: 'followers' | 'followings';
}) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const cardB = usePerfMode().blur(20);
  const followers = useUserFollowers(mode === 'followers' ? urn : undefined);
  const followings = useUserFollowings(mode === 'followings' ? urn : undefined);
  const q = mode === 'followers' ? followers : followings;
  const isSyncing =
    (q.data?.pages.some((page) => page.sync?.status === 'refreshing') ?? false) &&
    q.users.length === 0;
  const [retryEpoch, setRetryEpoch] = useState(0);
  const syncTimedOut = useSyncTimeout(isSyncing, retryEpoch);
  const syncPending = isSyncing && syncTimedOut;
  const retrySync = () => {
    setRetryEpoch((epoch) => epoch + 1);
    q.retrySync();
  };
  const ref = useInfiniteScroll(!!q.hasNextPage, !!q.isFetchingNextPage, q.fetchNextPage);

  const renderItem = useCallback(
    (user: (typeof q.users)[number]) => (
      <button
        type="button"
        onClick={() => nav(`/user/${encodeURIComponent(user.urn)}`)}
        className="group relative h-full w-full flex flex-col items-center gap-3 p-6 rounded-3xl transition-transform duration-500 cursor-pointer overflow-hidden hover:scale-[1.02]"
        style={{
          background: cardB > 0 ? 'rgba(255,255,255,0.03)' : 'rgba(24,24,28,0.85)',
          border: '0.5px solid rgba(255,255,255,0.06)',
          backdropFilter: cardB > 0 ? `blur(${cardB}px)` : undefined,
          WebkitBackdropFilter: cardB > 0 ? `blur(${cardB}px)` : undefined,
        }}
      >
        <div className="w-20 h-20 rounded-full overflow-hidden ring-2 ring-white/10 group-hover:ring-white/30 transition-all duration-500">
          <Avatar src={user.avatar_url} alt={user.username} size={80} />
        </div>
        <div className="text-center min-w-0 w-full">
          <p className="text-[13px] font-semibold text-white/90 truncate group-hover:text-white">
            {user.username}
          </p>
          {user.followers_count != null && (
            <p className="text-[10px] text-white/30 mt-1 tabular-nums uppercase tracking-widest font-semibold">
              {fc(user.followers_count)} {t('user.followers')}
            </p>
          )}
        </div>
      </button>
    ),
    [nav, t, cardB],
  );

  const emptyText = mode === 'followers' ? t('user.noFollowers') : t('user.noFollowings');

  return (
    <TabWrapper
      isLoading={q.isLoading || (isSyncing && !syncPending)}
      isEmpty={q.users.length === 0}
      error={q.error}
      emptyText={emptyText}
      syncPending={syncPending}
      onRetrySync={retrySync}
    >
      <VirtualGrid
        items={q.users}
        itemHeight={220}
        minColumnWidth={200}
        gap={20}
        overscan={3}
        getItemKey={(u) => u.urn}
        renderItem={renderItem}
      />
      <div ref={ref} className="h-16 flex items-center justify-center">
        {q.isFetchingNextPage && <Loader2 size={20} className="text-white/20 animate-spin" />}
      </div>
    </TabWrapper>
  );
}
