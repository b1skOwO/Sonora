import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArtistMiniCard } from '../components/library/ArtistMiniCard';
import { CollectionRail } from '../components/library/CollectionRail';
import { ContinueRow } from '../components/library/ContinueRow';
import { FreshDrops } from '../components/library/FreshDrops';
import { LibraryFrame } from '../components/library/LibraryFrame';
import { SoundPrintMasthead } from '../components/library/SoundPrintMasthead';
import { useSoundprint } from '../components/library/useSoundprint';
import { PlaylistCard } from '../components/music/PlaylistCard';
import { TrackCard } from '../components/music/TrackCard';
import { CreatePlaylistTile } from '../components/playlist/CreatePlaylistDialog';
import { useLikedTracks, useMyFollowings, useMyLikedPlaylists, useMyPlaylists } from '../lib/hooks';
import { Bookmark, Heart, ListMusic, Users, Youtube } from '../lib/icons';
import { likedTracksCount } from '../lib/likes';
import { armLikesContinuation } from '../lib/queue-continuation';
import { useAuthStore } from '../stores/auth';
import { useUnifiedLikes } from '../stores/local-likes';
import { localPlaylistToCard, useLocalPlaylistsStore } from '../stores/local-playlists';
import { useServiceStore } from '../stores/service';

/** Library "Hub" — a living home base. Your identity up top, then a way back
 *  into what you were playing, then shelves into the deep pages of your
 *  collection — and fresh drops from who you follow at the very bottom. */
export const Library = React.memo(() => {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const { tracks: likedTracks } = useLikedTracks();
  // Picked genre tag — retints the whole hub and filters its genre-aware shelves.
  const [genre, setGenre] = useState<string | null>(null);
  const sound = useSoundprint(likedTracks, genre);

  const { playlists, isLoading: playlistsLoading } = useMyPlaylists();
  const { playlists: likedPlaylists } = useMyLikedPlaylists();
  const { users: followings } = useMyFollowings();
  const localPlaylists = useLocalPlaylistsStore((s) => s.playlists);
  const unifiedLikes = useUnifiedLikes();
  const service = useServiceStore((s) => s.service);

  const playlistPreview = useMemo(() => {
    const base = genre ? playlists.filter((p) => p.genre?.trim() === genre) : playlists;
    return base.slice(0, 12);
  }, [playlists, genre]);
  const likedPlaylistPreview = useMemo(() => {
    const base = genre ? likedPlaylists.filter((p) => p.genre?.trim() === genre) : likedPlaylists;
    return base.slice(0, 12);
  }, [likedPlaylists, genre]);
  const artistPreview = useMemo(() => followings.slice(0, 14), [followings]);
  const likesPreview = useMemo(() => {
    const base = genre ? likedTracks.filter((tr) => tr.genre?.trim() === genre) : likedTracks;
    return base.slice(0, 12);
  }, [likedTracks, genre]);
  const localLikesPreview = useMemo(() => unifiedLikes.slice(0, 12), [unifiedLikes]);

  if (!user) return null;

  // YouTube mode: the collection is the imported playlists only —
  // SoundCloud shelves stay in SoundCloud mode.
  if (service === 'youtube') {
    return (
      <LibraryFrame sound={sound}>
        <div className="space-y-9">
          {localLikesPreview.length > 0 && (
            <CollectionRail
              icon={<Heart size={16} />}
              title={t('library.localLikes')}
              count={unifiedLikes.length}
              to="/library/local-likes"
            >
              {localLikesPreview.map((tr) => (
                <div key={tr.urn} className="w-[150px] shrink-0">
                  <TrackCard track={tr} queue={unifiedLikes} />
                </div>
              ))}
            </CollectionRail>
          )}
          <CollectionRail
            icon={<Youtube size={16} />}
            title={t('library.importedPlaylists')}
            count={localPlaylists.length}
            to="/library/playlists"
          >
            <CreatePlaylistTile />
            {localPlaylists.map((p) => (
              <div key={p.id} className="w-[160px] shrink-0">
                <PlaylistCard playlist={localPlaylistToCard(p)} />
              </div>
            ))}
          </CollectionRail>
          {localPlaylists.length === 0 && (
            <p className="text-[13px] text-white/35">{t('library.noLocalPlaylists')}</p>
          )}
        </div>
      </LibraryFrame>
    );
  }

  return (
    <LibraryFrame sound={sound}>
      <div className="space-y-9">
        <SoundPrintMasthead
          user={user}
          likedTracks={likedTracks}
          sound={sound}
          selected={genre}
          onSelect={setGenre}
        />

        <ContinueRow genre={genre} />

        {!playlistsLoading && (!genre || playlistPreview.length > 0) && (
          <CollectionRail
            icon={<ListMusic size={16} />}
            title={t('library.yourPlaylists')}
            count={user.playlist_count}
            to="/library/playlists"
          >
            <CreatePlaylistTile />
            {playlistPreview.map((p) => (
              <div key={p.urn} className="w-[160px] shrink-0">
                <PlaylistCard playlist={p} />
              </div>
            ))}
          </CollectionRail>
        )}

        {localPlaylists.length > 0 && (
          <CollectionRail
            icon={<Youtube size={16} />}
            title={t('library.importedPlaylists')}
            to="/library/playlists"
          >
            {localPlaylists.map((p) => (
              <div key={p.id} className="w-[160px] shrink-0">
                <PlaylistCard playlist={localPlaylistToCard(p)} />
              </div>
            ))}
          </CollectionRail>
        )}

        {likedPlaylistPreview.length > 0 && (
          <CollectionRail
            icon={<Bookmark size={16} />}
            title={t('library.likedPlaylists')}
            to="/library/playlists"
          >
            {likedPlaylistPreview.map((p) => (
              <div key={p.urn} className="w-[160px] shrink-0">
                <PlaylistCard playlist={p} />
              </div>
            ))}
          </CollectionRail>
        )}

        {artistPreview.length > 0 && (
          <CollectionRail
            icon={<Users size={16} />}
            title={t('library.artists')}
            count={user.followings_count}
            to="/library/following"
          >
            {artistPreview.map((u) => (
              <ArtistMiniCard key={u.urn} user={u} />
            ))}
          </CollectionRail>
        )}

        {likesPreview.length > 0 && (
          <CollectionRail
            icon={<Heart size={16} />}
            title={t('library.likedTracks')}
            count={likedTracksCount(user)}
            to="/library/likes"
          >
            {likesPreview.map((tr) => (
              <div key={tr.urn} className="w-[150px] shrink-0">
                <TrackCard
                  track={tr}
                  queue={likesPreview}
                  onPlay={genre ? undefined : armLikesContinuation}
                />
              </div>
            ))}
          </CollectionRail>
        )}

        {localLikesPreview.length > 0 && (
          <CollectionRail
            icon={<Heart size={16} />}
            title={t('library.localLikes')}
            count={unifiedLikes.length}
            to="/library/local-likes"
          >
            {localLikesPreview.map((tr) => (
              <div key={tr.urn} className="w-[150px] shrink-0">
                <TrackCard track={tr} queue={unifiedLikes} />
              </div>
            ))}
          </CollectionRail>
        )}

        <FreshDrops genre={genre} />
      </div>
    </LibraryFrame>
  );
});
