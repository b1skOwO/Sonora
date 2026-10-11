import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveStation } from '../components/home/river/ArchiveStation';
import { RIVER_KEYFRAMES } from '../components/home/river/keyframes';
import { RiverMasthead } from '../components/home/river/RiverMasthead';
import { WaveFrame } from '../components/home/WaveFrame';
import { YoutubeHome } from '../components/home/YoutubeHome';
import { CollectionRail } from '../components/library/CollectionRail';
import { ContinueRow } from '../components/library/ContinueRow';
import { FreshDrops } from '../components/library/FreshDrops';
import { useSoundprint } from '../components/library/useSoundprint';
import { PlaylistCard } from '../components/music/PlaylistCard';
import { TrackCard } from '../components/music/TrackCard';
import { useLikedTracks, useMyPlaylists } from '../lib/hooks';
import { Heart, ListMusic } from '../lib/icons';
import { likedTracksCount } from '../lib/likes';
import { armLikesContinuation } from '../lib/queue-continuation';
import { useAuthStore } from '../stores/auth';
import { useUnifiedLikes } from '../stores/local-likes';
import { localPlaylistToCard, useLocalPlaylistsStore } from '../stores/local-playlists';
import { useServiceStore } from '../stores/service';

/** SoundCloud home without the river: the recommendations feed behind it
 *  takes up to a minute+ on slow connections, blocking the whole page on
 *  skeletons. Fast shelves only (history / fresh drops / likes) — the wave
 *  keeps living on its own surfaces. */
function SoundCloudHome() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const likedTracksQuery = useLikedTracks(100);

  // Выбранный жанр спектра ретинтит всю страницу (атмосфера + шапка).
  const [genre, setGenre] = useState<string | null>(null);
  const sound = useSoundprint(likedTracksQuery.tracks, genre);

  const likedShelfTracks = useMemo(
    () => likedTracksQuery.tracks.slice(0, 50),
    [likedTracksQuery.tracks],
  );

  const { playlists } = useMyPlaylists();
  const localPlaylists = useLocalPlaylistsStore((s) => s.playlists);
  const unifiedLikes = useUnifiedLikes();
  const likesPreview = useMemo(() => {
    const base = genre
      ? likedTracksQuery.tracks.filter((tr) => tr.genre?.trim() === genre)
      : likedTracksQuery.tracks;
    return base.slice(0, 12);
  }, [likedTracksQuery.tracks, genre]);
  const unifiedPreview = useMemo(() => unifiedLikes.slice(0, 12), [unifiedLikes]);
  const playlistPreview = useMemo(() => {
    const base = genre ? playlists.filter((p) => p.genre?.trim() === genre) : playlists;
    return base.slice(0, 12);
  }, [playlists, genre]);

  return (
    <WaveFrame sound={sound}>
      <style>{RIVER_KEYFRAMES}</style>
      {user && <RiverMasthead user={user} sound={sound} selected={genre} onSelect={setGenre} />}

      <ContinueRow genre={genre} />

      <FreshDrops genre={genre} />

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

      {unifiedPreview.length > 0 && (
        <CollectionRail
          icon={<Heart size={16} />}
          title={t('library.localLikes')}
          count={unifiedLikes.length}
          to="/library/local-likes"
        >
          {unifiedPreview.map((tr) => (
            <div key={tr.urn} className="w-[150px] shrink-0">
              <TrackCard track={tr} queue={unifiedLikes} />
            </div>
          ))}
        </CollectionRail>
      )}

      {playlistPreview.length > 0 && (
        <CollectionRail
          icon={<ListMusic size={16} />}
          title={t('library.yourPlaylists')}
          count={user?.playlist_count}
          to="/library/playlists"
        >
          {playlistPreview.map((p) => (
            <div key={p.urn} className="w-[160px] shrink-0">
              <PlaylistCard playlist={p} />
            </div>
          ))}
        </CollectionRail>
      )}

      {localPlaylists.length > 0 && (
        <CollectionRail
          icon={<ListMusic size={16} />}
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

      <ArchiveStation likedTracks={likedShelfTracks} likedLoading={likedTracksQuery.isLoading} />
    </WaveFrame>
  );
}

/** Home is service-aware: SoundCloud shows the river, YouTube shows the
 *  imported playlists + YouTube picks — no cross-service content. */
export function Home() {
  const service = useServiceStore((s) => s.service);
  if (service === 'youtube') return <YoutubeHome />;
  return <SoundCloudHome />;
}
