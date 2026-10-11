import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { proxiedAssetUrl } from '../../lib/asset-url';
import { updateYtDlp } from '../../lib/cache';
import { X, Youtube } from '../../lib/icons';
import { fetchYoutubePlaylist, YOUTUBE_PLAYLIST_PREFIX, ytEntryToTrack } from '../../lib/youtube';
import { type UpgradeProgress, upgradeYoutubeEntries } from '../../lib/youtube-upgrade';
import type { LocalPlaylist } from '../../stores/local-playlists';
import { useLocalPlaylistsStore } from '../../stores/local-playlists';
import { usePlayerStore } from '../../stores/player';
import { Modal, ModalClose, ModalContent, ModalTitle } from '../ui/Modal';

function formatError(error: unknown): string {
  const raw =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

function YoutubeImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<'idle' | 'fetch' | 'upgrade'>('idle');
  const [progress, setProgress] = useState<UpgradeProgress | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LocalPlaylist | null>(null);
  const [replaced, setReplaced] = useState(0);
  const [replaceOfficial, setReplaceOfficial] = useState(true);
  const cancelRef = useRef(false);

  const busy = phase !== 'idle';

  useEffect(() => {
    if (!open && !busy) {
      setUrl('');
      setError(null);
      setResult(null);
      setReplaced(0);
      setProgress(null);
    }
  }, [busy, open]);

  const handleImport = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    cancelRef.current = false;
    setPhase('fetch');
    setError(null);
    setResult(null);
    setProgress(null);
    setReplaced(0);
    try {
      const playlist = await fetchYoutubePlaylist(trimmed);
      let entries = playlist.entries;
      let replacedCount = 0;
      if (replaceOfficial && entries.length > 0) {
        setPhase('upgrade');
        const outcome = await upgradeYoutubeEntries(entries, {
          shouldCancel: () => cancelRef.current,
          onProgress: setProgress,
        });
        entries = outcome.entries;
        replacedCount = outcome.replaced;
      }
      const tracks = entries.map((entry) => ytEntryToTrack(entry, playlist.uploader));
      const local: LocalPlaylist = {
        id: `${YOUTUBE_PLAYLIST_PREFIX}${playlist.id ?? Date.now().toString(36)}`,
        title: playlist.title,
        uploader: playlist.uploader,
        artworkUrl: tracks[0]?.artwork_url ?? null,
        sourceUrl: trimmed,
        source: 'youtube',
        tracks,
        createdAt: Date.now(),
      };
      useLocalPlaylistsStore.getState().upsert(local);
      setReplaced(replacedCount);
      setResult(local);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setPhase('idle');
      setProgress(null);
    }
  }, [url, replaceOfficial]);

  const handlePlay = useCallback(() => {
    if (!result || result.tracks.length === 0) return;
    onOpenChange(false);
    usePlayerStore.getState().play(result.tracks[0], result.tracks);
  }, [onOpenChange, result]);

  const handleUpdateYtDlp = useCallback(async () => {
    setUpdating(true);
    try {
      const ok = await updateYtDlp();
      if (ok) toast.success(t('yt.updated'));
      else toast.error(t('yt.updateFailed'));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUpdating(false);
    }
  }, [t]);

  const handleOpen = useCallback(() => {
    if (!result) return;
    onOpenChange(false);
    navigate(`/playlist/${encodeURIComponent(result.id)}`);
  }, [navigate, onOpenChange, result]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="md" showClose={false} zClass="z-[80]">
        <div className="px-7 pt-6 pb-4 border-b border-white/[0.06] flex items-center justify-between">
          <ModalTitle className="text-[18px] font-bold text-white/90 tracking-tight inline-flex items-center gap-2">
            <Youtube size={18} className="text-white/70" />
            {t('settings.importYoutube')}
          </ModalTitle>
          <ModalClose asChild>
            <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/[0.08] transition-all cursor-pointer">
              <X size={16} />
            </button>
          </ModalClose>
        </div>

        <div className="px-7 py-5 space-y-5">
          {result ? (
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-xl">
              <div className="absolute inset-0 bg-gradient-to-br from-accent/10 via-transparent to-transparent" />
              <div className="relative p-5 flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl bg-white/[0.06] border border-white/[0.06] flex items-center justify-center shrink-0 overflow-hidden">
                  {result.artworkUrl ? (
                    <img
                      src={proxiedAssetUrl(result.artworkUrl) ?? ''}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Youtube size={26} className="text-white/40" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-bold text-white/90 truncate">{result.title}</p>
                  <p className="text-[12px] text-white/40 mt-0.5">
                    {result.tracks.length} {t('search.tracks').toLowerCase()}
                  </p>
                  <p className="text-[11px] mt-1 text-green-400/80">{t('yt.done')}</p>
                  {replaced > 0 && (
                    <p className="text-[11px] mt-0.5 text-accent/85">
                      {t('yt.replacedCount', { count: replaced })}
                    </p>
                  )}
                </div>
              </div>
              <div className="relative px-5 pb-5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handlePlay}
                  className="px-5 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[13px] font-semibold text-accent border border-accent/10 transition-all cursor-pointer"
                >
                  {t('yt.play')}
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
                <p className="font-medium text-white/70">{t('yt.instructions')}</p>
                <p className="text-[12px] leading-relaxed">{t('yt.hint')}</p>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={replaceOfficial}
                  disabled={busy}
                  onChange={(e) => setReplaceOfficial(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-[var(--color-accent)] cursor-pointer"
                />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-white/75">
                    {t('yt.replaceOfficial')}
                  </span>
                  <span className="block text-[11px] text-white/35 mt-0.5 leading-snug">
                    {t('yt.replaceOfficialDesc')}
                  </span>
                </span>
              </label>

              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void handleImport();
                }}
                placeholder={t('yt.urlPlaceholder')}
                disabled={busy}
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:border-white/[0.12] focus:bg-white/[0.06] transition-all duration-200 outline-none disabled:opacity-50"
              />

              {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3">
                  <p className="text-[12px] text-red-300/90 break-words">{error}</p>
                </div>
              )}

              {busy && (
                <div className="space-y-3">
                  <div className="rounded-2xl border border-accent/15 bg-accent/[0.07] px-4 py-3 backdrop-blur-xl">
                    <p className="text-[12px] font-medium text-white/78">
                      {phase === 'upgrade' ? t('yt.upgrading') : t('yt.preparing')}
                    </p>
                    {phase === 'upgrade' && progress && progress.current && (
                      <p className="text-[11px] text-white/40 mt-1 truncate">
                        {progress.done}/{progress.total} · {progress.replaced}{' '}
                        {t('yt.replacedShort')} — {progress.current}
                      </p>
                    )}
                  </div>
                  <div className="w-full h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-300"
                      style={{
                        width:
                          phase === 'upgrade' && progress && progress.total > 0
                            ? `${Math.round((progress.done / progress.total) * 100)}%`
                            : '33%',
                      }}
                    />
                  </div>
                  {phase === 'upgrade' && (
                    <button
                      type="button"
                      onClick={() => {
                        cancelRef.current = true;
                      }}
                      className="text-[12px] font-medium text-white/40 hover:text-white/75 transition-colors cursor-pointer"
                    >
                      {t('yt.cancelUpgrade')}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {!result && (
          <div className="px-7 py-4 border-t border-white/[0.06] flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleUpdateYtDlp()}
              disabled={updating || busy}
              className="text-[12px] font-medium text-white/35 hover:text-white/70 transition-colors cursor-pointer disabled:opacity-40"
            >
              {updating ? t('yt.updating') : t('yt.update')}
            </button>
            <button
              onClick={() => void handleImport()}
              disabled={!url.trim() || busy}
              className="ml-auto px-5 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[13px] font-semibold text-accent border border-accent/20 transition-all cursor-pointer disabled:opacity-30"
            >
              {busy ? t('yt.importing') : t('yt.import')}
            </button>
          </div>
        )}
      </ModalContent>
    </Modal>
  );
}

export default YoutubeImportDialog;
