import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/shallow';
import { proxiedAssetUrl } from '../../lib/asset-url';
import { Spotify, X } from '../../lib/icons';
import { usePlayerStore } from '../../stores/player';
import { useSpotifyImportStore } from '../../stores/spotify-import';
import { Modal, ModalClose, ModalContent, ModalTitle } from '../ui/Modal';

function formatError(error: unknown): string {
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

function SpotifyImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const { phase, progress, playlist, error, startImport, stopImport, clearFinished } =
    useSpotifyImportStore(
      useShallow((state) => ({
        phase: state.phase,
        progress: state.progress,
        playlist: state.playlist,
        error: state.error,
        startImport: state.startImport,
        stopImport: state.stopImport,
        clearFinished: state.clearFinished,
      })),
    );

  const running = phase === 'running' || phase === 'stopping';

  useEffect(() => {
    if (!open && !running) {
      setUrl('');
      clearFinished();
    }
  }, [clearFinished, open, running]);

  const handleStart = useCallback(() => {
    void startImport(url);
  }, [startImport, url]);

  const handlePlay = useCallback(() => {
    if (!playlist || playlist.tracks.length === 0) return;
    onOpenChange(false);
    usePlayerStore.getState().play(playlist.tracks[0], playlist.tracks);
  }, [onOpenChange, playlist]);

  const handleOpen = useCallback(() => {
    if (!playlist) return;
    onOpenChange(false);
    navigate(`/playlist/${encodeURIComponent(playlist.id)}`);
  }, [navigate, onOpenChange, playlist]);

  const pct =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="md" showClose={false} zClass="z-[80]">
        <div className="px-7 pt-6 pb-4 border-b border-white/[0.06] flex items-center justify-between">
          <ModalTitle className="text-[18px] font-bold text-white/90 tracking-tight inline-flex items-center gap-2">
            <Spotify size={18} className="text-[#1db954]" />
            {t('settings.importSpotify')}
          </ModalTitle>
          <ModalClose asChild>
            <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/[0.08] transition-all cursor-pointer">
              <X size={16} />
            </button>
          </ModalClose>
        </div>

        <div className="px-7 py-5 space-y-5">
          {playlist ? (
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-xl">
              <div className="absolute inset-0 bg-gradient-to-br from-[#1db954]/10 via-transparent to-transparent" />
              <div className="relative p-5 flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-white/[0.06] border border-white/[0.06] flex items-center justify-center shrink-0 overflow-hidden">
                  {playlist.artworkUrl ? (
                    <img
                      src={proxiedAssetUrl(playlist.artworkUrl) ?? ''}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Spotify size={26} className="text-[#1db954]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-bold text-white/90 truncate">{playlist.title}</p>
                  <p className="text-[12px] text-white/40 mt-0.5">
                    {playlist.tracks.length} {t('search.tracks').toLowerCase()}
                    {progress && progress.not_found > 0
                      ? ` • ${t('spotify.notFound')}: ${progress.not_found}`
                      : ''}
                  </p>
                  <p className="text-[11px] mt-1 text-green-400/80">
                    {phase === 'stopped' ? t('spotify.stopped') : t('spotify.done')}
                  </p>
                </div>
              </div>
              <div className="relative px-5 pb-5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handlePlay}
                  className="px-5 py-2 rounded-xl bg-[#1db954]/20 hover:bg-[#1db954]/30 text-[13px] font-semibold text-[#3ee07a] border border-[#1db954]/20 transition-all cursor-pointer"
                >
                  {t('spotify.play')}
                </button>
                <button
                  type="button"
                  onClick={handleOpen}
                  className="px-5 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] text-[13px] font-semibold text-white/72 border border-white/[0.08] transition-all cursor-pointer"
                >
                  {t('common.seeAll')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 text-[13px] text-white/50">
                <p className="font-medium text-white/70">{t('spotify.instructions')}</p>
                <p className="text-[12px] leading-relaxed">{t('spotify.hint')}</p>
              </div>

              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !running) handleStart();
                }}
                placeholder={t('spotify.urlPlaceholder')}
                disabled={running}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none disabled:opacity-50"
              />

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3">
                  <p className="text-[12px] text-red-300/90 break-words">{formatError(error)}</p>
                </div>
              )}

              {running && (
                <div className="space-y-3">
                  <div className="rounded-2xl border border-[#1db954]/15 bg-[#1db954]/[0.06] px-4 py-3 backdrop-blur-xl">
                    <p className="text-[12px] font-medium text-white/78">
                      {progress ? t('spotify.matching') : t('spotify.importing')}
                    </p>
                  </div>
                  <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    {progress ? (
                      <div
                        className="h-full rounded-full bg-[#1db954] transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    ) : (
                      <div className="h-full w-1/3 rounded-full bg-[#1db954] animate-pulse" />
                    )}
                  </div>
                  {progress && (
                    <div className="flex items-center justify-between text-[12px] text-white/40">
                      <span>
                        {progress.current} / {progress.total}
                      </span>
                      <span className="text-green-400">
                        {t('spotify.matched')}: {progress.matched}
                      </span>
                      <span className="text-red-400">
                        {t('spotify.notFound')}: {progress.not_found}
                      </span>
                    </div>
                  )}
                  {progress?.current_track && (
                    <p className="text-[12px] text-white/30 truncate">{progress.current_track}</p>
                  )}
                  <p className="text-[11px] text-white/25">{t('spotify.backgroundHint')}</p>
                </div>
              )}

              {phase === 'done' && !playlist && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
                  <p className="text-[12px] text-amber-300/90">{t('spotify.noMatches')}</p>
                </div>
              )}
            </>
          )}
        </div>

        {!playlist && (
          <div className="px-7 py-4 border-t border-white/[0.06] flex items-center justify-end gap-3">
            {running ? (
              <>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-5 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.09] text-[13px] font-semibold text-white/72 border border-white/[0.08] transition-all cursor-pointer"
                >
                  {t('spotify.hide')}
                </button>
                <button
                  type="button"
                  onClick={() => void stopImport()}
                  disabled={phase === 'stopping'}
                  className="px-5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-[13px] font-semibold text-red-400 border border-red-500/10 transition-all cursor-pointer"
                >
                  {t('spotify.stop')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                disabled={!url.trim()}
                className="px-5 py-2 rounded-xl bg-[#1db954]/20 hover:bg-[#1db954]/30 text-[13px] font-semibold text-[#3ee07a] border border-[#1db954]/20 transition-all cursor-pointer disabled:opacity-30"
              >
                {t('spotify.start')}
              </button>
            )}
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}

export default SpotifyImportDialog;
