import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArchiveStation } from '../components/home/river/ArchiveStation';
import { RIVER_KEYFRAMES } from '../components/home/river/keyframes';
import { RiverMasthead } from '../components/home/river/RiverMasthead';
import { WaveFrame } from '../components/home/WaveFrame';
import { YoutubeHome } from '../components/home/YoutubeHome';
import { CollectionRail } from '../components/library/CollectionRail';
import { ContinueRow } from '../components/library/ContinueRow';
import { FreshDrops } from '../components/library/FreshDrops';
import { historyTrackUrn } from '../components/library/history-utils';
import { useSoundprint } from '../components/library/useSoundprint';
import { PlaylistCard } from '../components/music/PlaylistCard';
import { TrackCard } from '../components/music/TrackCard';
import { useHistory, useLikedTracks, useMyPlaylists } from '../lib/hooks';
import { Heart, ListMusic, Plus, RefreshCw } from '../lib/icons';
import { likedTracksCount } from '../lib/likes';
import { armLikesContinuation } from '../lib/queue-continuation';
import { useUnheardPicks } from '../lib/unheard-picks';
import { useAuthStore } from '../stores/auth';
import { useUnifiedLikes } from '../stores/local-likes';
import type { LocalPlaylist } from '../stores/local-playlists';
import { localPlaylistToCard, useLocalPlaylistsStore } from '../stores/local-playlists';
import type { Track } from '../stores/player';
import { useServiceStore } from '../stores/service';

const RANDOM_MIX_SIZE = 15;

/** One ephemeral playlist: a shuffled pick across unified likes + every
 *  imported playlist, deduped. Re-rolled on demand — never saved, so the
 *  library stays clean. */
function buildRandomMix(
  likes: Track[],
  imports: LocalPlaylist[],
  count: number = RANDOM_MIX_SIZE,
): Track[] {
  const pool = [...likes];
  const seen = new Set(pool.map((t) => t.urn));
  for (const playlist of imports) {
    for (const track of playlist.tracks) {
      if (!seen.has(track.urn)) {
        seen.add(track.urn);
        pool.push(track);
      }
    }
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** SoundCloud home without the river: the recommendations feed behind it
 *  takes up to a minute+ on slow connections, blocking the whole page on
 *  skeletons. Fast shelves only (history / fresh drops / likes) — the wave
 *  keeps living on its own surfaces. */
function SoundCloudHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const [mixSeed, setMixSeed] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mixSeed re-rolls the mix on demand
  const randomMix = useMemo(
    () => buildRandomMix(unifiedLikes, localPlaylists),
    [unifiedLikes, localPlaylists, mixSeed],
  );

  // Everything already heard: history + backend likes + local hearts.
  const { entries: historyEntries } = useHistory();
  const heardUrns = useMemo(() => {
    const heard = new Set<string>();
    for (const entry of historyEntries) heard.add(historyTrackUrn(entry.scTrackId));
    for (const track of likedTracksQuery.tracks) heard.add(track.urn);
    for (const track of unifiedLikes) heard.add(track.urn);
    return heard;
  }, [historyEntries, likedTracksQuery.tracks, unifiedLikes]);

  const [unheardSeed, setUnheardSeed] = useState(0);
  const unheard = useUnheardPicks({
    likedTracks: likedTracksQuery.tracks,
    heardUrns,
    nonce: unheardSeed,
  });

  const handleSaveUnheard = () => {
    if (unheard.tracks.length === 0) return;
    const playlist: LocalPlaylist = {
      id: `mix:playlists:unheard-${Date.now().toString(36)}`,
      title: t('home.unheardTitle'),
      uploader: null,
      artworkUrl: unheard.tracks[0]?.artwork_url ?? null,
      sourceUrl: '',
      source: 'mix',
      tracks: unheard.tracks,
      createdAt: Date.now(),
    };
    useLocalPlaylistsStore.getState().upsert(playlist);
    toast.success(t('playlist.created'));
    navigate(`/playlist/${encodeURIComponent(playlist.id)}`);
  };
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

      {randomMix.length > 0 && (
        <CollectionRail
          icon={<RefreshCw size={16} />}
          title={t('home.randomMix')}
          count={randomMix.length}
          to="/library/local-likes"
          action={
            <button
              type="button"
              onClick={() => setMixSeed((s) => s + 1)}
              title={t('discover.prismShuffle')}
              aria-label={t('discover.prismShuffle')}
              className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white/35 hover:text-white/80 hover:bg-white/[0.07] transition-all cursor-pointer"
            >
              <RefreshCw size={14} />
            </button>
          }
        >
          {randomMix.map((tr) => (
            <div key={tr.urn} className="w-[150px] shrink-0">
              <TrackCard track={tr} queue={randomMix} />
            </div>
          ))}
        </CollectionRail>
      )}

      {unheard.tracks.length > 0 && (
        <CollectionRail
          icon={<Plus size={16} />}
          title={t('home.unheardTitle')}
          count={unheard.tracks.length}
          action={
            <>
              <button
                type="button"
                onClick={() => setUnheardSeed((s) => s + 1)}
                title={t('discover.prismShuffle')}
                aria-label={t('discover.prismShuffle')}
                className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white/35 hover:text-white/80 hover:bg-white/[0.07] transition-all cursor-pointer"
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                onClick={handleSaveUnheard}
                title={t('playlist.create')}
                aria-label={t('playlist.create')}
                className="shrink-0 h-7 px-3 rounded-full inline-flex items-center gap-1 text-[11px] font-semibold text-white/55 hover:text-white/90 hover:bg-white/[0.07] transition-all cursor-pointer"
              >
                <Plus size={13} />
                {t('playlist.create')}
              </button>
            </>
          }
        >
          {unheard.tracks.map((tr) => (
            <div key={tr.urn} className="w-[150px] shrink-0">
              <TrackCard track={tr} queue={unheard.tracks} />
            </div>
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
