import { ask, open } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  type AudioCacheFormat,
  clearCache,
  clearImageCache,
  clearLikedCache,
  getCacheDir,
  getCacheFormat,
  getCacheSize,
  getImageCacheSize,
  getLikedCacheSize,
  restartApp,
  setCacheDir,
  setCacheFormat,
} from '../../../lib/cache';
import { formatBytes } from '../../../lib/formatters';
import { Database, Download, Loader2, Trash2, X } from '../../../lib/icons';
import { useCacheLikes } from '../../../lib/likes-cache';
import { useSettingsStore } from '../../../stores/settings';
import { Skeleton } from '../../ui/Skeleton';
import { Card, Divider, RangeSlider } from '../primitives';

const CACHE_FORMATS = ['m4a', 'mp3', 'wav'] as const;

function CacheRow({
  label,
  size,
  clearing,
  onClear,
  clearLabel,
}: {
  label: string;
  size: number | null;
  clearing: boolean;
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-[13px] text-white/60 font-medium">{label}</p>
        <div className="h-[25px] flex items-center">
          {size === null ? (
            <Skeleton className="w-25 h-[20px]" />
          ) : (
            <p className="text-[17px] font-bold text-white/90 tabular-nums">{formatBytes(size)}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onClear}
        disabled={clearing || size === 0}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/10 hover:border-red-500/20 transition-all duration-300 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
      >
        {clearing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
        {clearLabel}
      </button>
    </div>
  );
}

export function CacheCard() {
  const { t } = useTranslation();
  const audioCacheLimitMB = useSettingsStore((s) => s.audioCacheLimitMB);
  const setAudioCacheLimitMB = useSettingsStore((s) => s.setAudioCacheLimitMB);
  const cacheMaxAgeDays = useSettingsStore((s) => s.cacheMaxAgeDays);
  const setCacheMaxAgeDays = useSettingsStore((s) => s.setCacheMaxAgeDays);
  const [audioSize, setAudioSize] = useState<number | null>(null);
  const [imagesSize, setImagesSize] = useState<number | null>(null);
  const [likedSize, setLikedSize] = useState<number | null>(null);
  const [clearingAudio, setClearingAudio] = useState(false);
  const [clearingImages, setClearingImages] = useState(false);
  const [clearingLiked, setClearingLiked] = useState(false);
  const [cacheDir, setCacheDirState] = useState<string | null>(null);
  const [changingDir, setChangingDir] = useState(false);
  const [cacheFormat, setCacheFormatState] = useState<AudioCacheFormat>('m4a');
  const [changingFormat, setChangingFormat] = useState(false);

  const refreshLikedSize = useCallback(() => {
    void getLikedCacheSize().then(setLikedSize);
  }, []);

  const {
    caching: cachingLikes,
    progress,
    start: startLikes,
    cancel: cancelLikes,
  } = useCacheLikes((p) => {
    refreshLikedSize();
    if (p.phase === 'done') {
      toast.success(t('settings.cacheLikesDone', { done: p.done - p.failed, total: p.total }));
    }
  });

  useEffect(() => {
    void getCacheSize().then(setAudioSize);
    void getImageCacheSize().then(setImagesSize);
    refreshLikedSize();
    void getCacheDir().then(setCacheDirState);
    void getCacheFormat().then(setCacheFormatState);
  }, [refreshLikedSize]);

  const handleChangeFormat = useCallback(
    async (next: AudioCacheFormat) => {
      if (next === cacheFormat || changingFormat) return;
      const ok = await ask(t('settings.cacheFormatConfirm'), {
        title: t('settings.cacheFormat'),
        kind: 'info',
      });
      if (!ok) return;
      setChangingFormat(true);
      try {
        await setCacheFormat(next);
        setCacheFormatState(next);
        toast.success(t('settings.cacheFormatChanged'));
      } catch (e) {
        toast.error(String(e));
      } finally {
        setChangingFormat(false);
      }
    },
    [cacheFormat, changingFormat, t],
  );

  const handleChangeCacheDir = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('settings.cacheDirPick'),
      });
      if (!selected || typeof selected !== 'string') return;
      const moveFiles = await ask(t('settings.cacheDirMoveConfirm'), {
        title: t('settings.cacheDir'),
        kind: 'info',
      });
      setChangingDir(true);
      await setCacheDir(selected, moveFiles);
      setCacheDirState(selected);
      toast.success(t('settings.cacheDirChanged'));
      const restartNow = await ask(t('settings.cacheDirRestart'), {
        title: t('settings.cacheDir'),
        kind: 'warning',
      });
      if (restartNow) await restartApp();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setChangingDir(false);
    }
  }, [t]);

  const clearWith = useCallback(
    async (
      fn: () => Promise<unknown>,
      setBusy: (b: boolean) => void,
      setSize: (n: number) => void,
    ) => {
      setBusy(true);
      try {
        await fn();
        setSize(0);
        toast.success(t('settings.cacheCleared'));
      } catch {
        toast.error(t('common.error'));
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const handleCacheLikes = useCallback(async () => {
    try {
      const queued = await startLikes();
      if (queued === 0) toast(t('settings.cacheLikesEmpty'));
    } catch (err) {
      toast.error(String(err));
    }
  }, [startLikes, t]);

  const totalSize = (audioSize ?? 0) + (imagesSize ?? 0) + (likedSize ?? 0);
  const allLoaded = audioSize !== null && imagesSize !== null && likedSize !== null;
  const limitLabel =
    audioCacheLimitMB <= 0
      ? t('settings.unlimited')
      : audioCacheLimitMB >= 1024
        ? `${(audioCacheLimitMB / 1024).toFixed(audioCacheLimitMB % 1024 === 0 ? 0 : 1)} GB`
        : `${audioCacheLimitMB} MB`;
  const ageLabel =
    cacheMaxAgeDays <= 0
      ? t('settings.cacheMaxAgeOff')
      : t('settings.cacheMaxAgeDays', { count: cacheMaxAgeDays });
  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  return (
    <Card
      title={t('settings.cache')}
      icon={<Database size={17} />}
      action={
        allLoaded ? (
          <span className="text-[12px] text-white/30 tabular-nums">
            {t('settings.total')}: {formatBytes(totalSize)}
          </span>
        ) : (
          <Skeleton className="h-[12px] w-[80px]" />
        )
      }
    >
      <div className="divide-y divide-white/[0.04]">
        <CacheRow
          label={t('settings.audioCacheSize')}
          size={audioSize}
          clearing={clearingAudio}
          clearLabel={t('settings.clearCache')}
          onClear={() => clearWith(clearCache, setClearingAudio, setAudioSize)}
        />
        <CacheRow
          label={t('settings.assetsCacheSize')}
          size={imagesSize}
          clearing={clearingImages}
          clearLabel={t('settings.clearCache')}
          onClear={() => clearWith(clearImageCache, setClearingImages, setImagesSize)}
        />
        <CacheRow
          label={t('settings.likedCacheSize')}
          size={likedSize}
          clearing={clearingLiked}
          clearLabel={t('settings.clearCache')}
          onClear={() => clearWith(clearLikedCache, setClearingLiked, setLikedSize)}
        />
      </div>

      <div className="pt-3 space-y-2">
        <p className="text-[11px] text-white/30">{t('settings.cacheLikesDesc')}</p>
        {cachingLikes ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[12px] text-white/60">
              <span className="flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                {progress
                  ? t('settings.cacheLikesProgress', { done: progress.done, total: progress.total })
                  : t('settings.cacheLikesStarting')}
              </span>
              {progress && progress.failed > 0 && (
                <span className="text-red-400/80 tabular-nums">
                  {t('settings.cacheLikesFailed', { count: progress.failed })}
                </span>
              )}
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <button
              type="button"
              onClick={cancelLikes}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold bg-white/[0.04] text-white/60 hover:bg-white/[0.08] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-200 cursor-pointer"
            >
              <X size={12} />
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleCacheLikes}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold bg-white/[0.06] text-white/75 hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-200 cursor-pointer"
          >
            <Download size={12} />
            {t('settings.cacheLikes')}
          </button>
        )}
      </div>

      <Divider />
      <div className="pt-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/60 font-medium">{t('settings.cacheMaxAge')}</p>
            <p className="text-[11px] text-white/30 mt-0.5">{t('settings.cacheMaxAgeDesc')}</p>
          </div>
          <span className="text-[12px] text-white/30 tabular-nums">{ageLabel}</span>
        </div>
        <RangeSlider
          value={cacheMaxAgeDays}
          min={0}
          max={30}
          step={1}
          onChange={setCacheMaxAgeDays}
        />
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            min={0}
            max={365}
            step={1}
            value={cacheMaxAgeDays}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value) || value < 0) return;
              setCacheMaxAgeDays(Math.min(365, Math.round(value)));
            }}
            className="w-24 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 tabular-nums outline-none focus:border-white/[0.14] transition-colors"
          />
          <span className="text-[12px] text-white/35">{t('settings.cacheMaxAgeUnit')}</span>
        </div>
      </div>

      <Divider />
      <div className="pt-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] text-white/60 font-medium">{t('settings.audioCacheLimit')}</p>
            <p className="text-[11px] text-white/30 mt-0.5">{t('settings.audioCacheLimitDesc')}</p>
          </div>
          <span className="text-[12px] text-white/30 tabular-nums">{limitLabel}</span>
        </div>
        <RangeSlider
          value={audioCacheLimitMB}
          min={0}
          max={8192}
          step={256}
          onChange={setAudioCacheLimitMB}
        />
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            min={0}
            max={65536}
            step={64}
            value={audioCacheLimitMB}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value) || value < 0) return;
              setAudioCacheLimitMB(Math.min(65536, Math.round(value)));
            }}
            className="w-24 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[13px] text-white/80 tabular-nums outline-none focus:border-white/[0.14] transition-colors"
          />
          <span className="text-[12px] text-white/35">MB</span>
        </div>
      </div>

      <Divider />
      <div className="pt-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13px] text-white/60 font-medium">{t('settings.cacheFormat')}</p>
            <p className="text-[11px] text-white/30 mt-0.5">{t('settings.cacheFormatDesc')}</p>
          </div>
          <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06] shrink-0">
            {CACHE_FORMATS.map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => void handleChangeFormat(fmt)}
                disabled={changingFormat}
                className={`px-3.5 py-1.5 rounded-lg text-[12px] font-semibold transition-all duration-200 cursor-pointer disabled:opacity-40 ${
                  cacheFormat === fmt
                    ? 'bg-[var(--color-accent)] text-accent-contrast'
                    : 'text-white/55 hover:text-white/85 hover:bg-white/[0.06]'
                }`}
              >
                {t(`settings.cacheFormat_${fmt}`)}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-white/30">{t('settings.cacheFormatNote')}</p>
      </div>

      <Divider />
      <div className="pt-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13px] text-white/60 font-medium">{t('settings.cacheDir')}</p>
            <p className="text-[11px] text-white/30 mt-0.5 truncate" title={cacheDir ?? undefined}>
              {cacheDir ?? '…'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleChangeCacheDir()}
            disabled={changingDir}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold bg-white/[0.06] text-white/75 hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-200 cursor-pointer disabled:opacity-40 shrink-0"
          >
            {changingDir ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <FolderOpen size={12} />
            )}
            {t('settings.cacheDirChange')}
          </button>
        </div>
        <p className="text-[11px] text-white/30">{t('settings.cacheDirDesc')}</p>
      </div>
    </Card>
  );
}
