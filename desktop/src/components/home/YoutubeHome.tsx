import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus, Sparkles, Youtube } from '../../lib/icons';
import { usePerfMode } from '../../lib/perf';
import { useYoutubePicks } from '../../lib/youtube-picks';
import { localPlaylistToCard, useLocalPlaylistsStore } from '../../stores/local-playlists';
import { CollectionRail } from '../library/CollectionRail';
import { PlaylistCard } from '../music/PlaylistCard';
import { TrackCard } from '../music/TrackCard';
import { Atmosphere } from '../search/Atmosphere';

/** YouTube mode home: the imported playlists plus picks searched on YouTube
 *  from the channels of those playlists. Nothing SoundCloud here — the SC
 *  river/archive shelves stay in SoundCloud mode. */
export const YoutubeHome = React.memo(function YoutubeHome() {
  const { t } = useTranslation();
  const playlists = useLocalPlaylistsStore((s) => s.playlists);
  const picks = useYoutubePicks(playlists);
  const perf = usePerfMode();

  const cards = useMemo(
    () => playlists.map((playlist) => localPlaylistToCard(playlist)),
    [playlists],
  );

  return (
    <div className="relative min-h-full w-full">
      {perf.atmosphere && <Atmosphere energy={0.55} />}
      <div
        className="relative z-10 min-h-full max-w-[1320px] mx-auto px-4 md:px-8 pt-5 pb-6 space-y-9"
        style={{ isolation: 'isolate' }}
      >
        <header className="flex items-center gap-3.5 pt-1">
          <span className="w-11 h-11 rounded-2xl flex items-center justify-center bg-white/[0.05] ring-1 ring-white/[0.08] shrink-0">
            <Youtube size={20} className="text-white/85" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold tracking-tight text-white/90">
              {t('service.youtube')}
            </h1>
            <p className="text-[12px] text-white/35 mt-0.5">{t('ytHome.subtitle')}</p>
          </div>
          <Link
            to="/import"
            className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[12.5px] font-semibold text-accent border border-accent/20 transition-all"
          >
            <Plus size={14} />
            {t('ytHome.import')}
          </Link>
        </header>

        {picks.tracks.length > 0 && (
          <CollectionRail icon={<Sparkles size={16} />} title={t('ytHome.forYou')} to="/search">
            {picks.tracks.map((track) => (
              <div key={track.urn} className="w-[150px] shrink-0">
                <TrackCard track={track} queue={picks.tracks} />
              </div>
            ))}
          </CollectionRail>
        )}

        {cards.length > 0 ? (
          <CollectionRail
            icon={<Youtube size={16} />}
            title={t('library.importedPlaylists')}
            count={cards.length}
            to="/library/playlists"
          >
            {cards.map((playlist) => (
              <div key={playlist.urn} className="w-[160px] shrink-0">
                <PlaylistCard playlist={playlist} />
              </div>
            ))}
          </CollectionRail>
        ) : (
          <div className="rounded-3xl border border-white/[0.06] bg-white/[0.02] px-6 py-10 text-center">
            <p className="text-[14px] font-semibold text-white/80">{t('ytHome.emptyTitle')}</p>
            <p className="text-[12px] text-white/35 mt-1.5">{t('ytHome.emptyBody')}</p>
            <Link
              to="/import"
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[12.5px] font-semibold text-accent border border-accent/20 transition-all"
            >
              <Plus size={14} />
              {t('ytHome.import')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
});
