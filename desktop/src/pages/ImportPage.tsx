import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Spotify, Youtube } from '../lib/icons';

const YMImportDialogLazy = React.lazy(() => import('../components/music/YMImportDialog'));
const YoutubeImportDialogLazy = React.lazy(() => import('../components/music/YoutubeImportDialog'));
const SpotifyImportDialogLazy = React.lazy(() => import('../components/music/SpotifyImportDialog'));

const BTN =
  'flex items-center gap-2 px-5 py-3 rounded-xl text-[13px] font-semibold bg-white/[0.06] text-white/70 hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-300 cursor-pointer';

/** Standalone import hub (sidebar tab): the same three importers as Settings. */
export const ImportPage = React.memo(function ImportPage() {
  const { t } = useTranslation();
  const [ymOpen, setYmOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [spOpen, setSpOpen] = useState(false);

  return (
    <div className="relative min-h-full w-full">
      <div className="relative z-10 max-w-[860px] mx-auto px-4 md:px-8 pt-10 pb-10 space-y-6">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-2xl flex items-center justify-center bg-white/[0.05] ring-1 ring-white/[0.08]">
            <Download size={17} className="text-white/70" />
          </span>
          <h1 className="text-[22px] font-black tracking-tight text-white/90">
            {t('nav.import')}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={() => setYmOpen(true)} className={BTN}>
            {t('settings.importYandex')}
          </button>
          <button type="button" onClick={() => setYtOpen(true)} className={BTN}>
            <Youtube size={15} />
            {t('settings.importYoutube')}
          </button>
          <button type="button" onClick={() => setSpOpen(true)} className={BTN}>
            <Spotify size={15} className="text-[#1db954]" />
            {t('settings.importSpotify')}
          </button>
        </div>
      </div>

      {ymOpen && (
        <React.Suspense fallback={null}>
          <YMImportDialogLazy open={ymOpen} onOpenChange={setYmOpen} />
        </React.Suspense>
      )}
      {ytOpen && (
        <React.Suspense fallback={null}>
          <YoutubeImportDialogLazy open={ytOpen} onOpenChange={setYtOpen} />
        </React.Suspense>
      )}
      {spOpen && (
        <React.Suspense fallback={null}>
          <SpotifyImportDialogLazy open={spOpen} onOpenChange={setSpOpen} />
        </React.Suspense>
      )}
    </div>
  );
});
