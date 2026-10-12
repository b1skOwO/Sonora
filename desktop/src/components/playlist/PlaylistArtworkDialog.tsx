import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ImagePlus, X } from '../../lib/icons';
import type { Track } from '../../stores/player';
import { usePlaylistArtworkStore } from '../../stores/playlist-artwork';
import { Modal, ModalClose, ModalContent, ModalTitle } from '../ui/Modal';

/** Downscale an image file to a small JPEG data URL so custom covers stay
 *  tiny in persisted settings (covers render at ≤500px anyway). */
async function fileToCoverDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const max = 512;
    const scale = Math.min(1, max / Math.max(1, bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob) throw new Error('encode failed');
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}

function looksLikeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export const PlaylistArtworkDialog = React.memo(function PlaylistArtworkDialog({
  urn,
  tracks,
  open,
  onOpenChange,
}: {
  urn: string;
  tracks: Pick<Track, 'urn' | 'artwork_url'>[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const current = usePlaylistArtworkStore((s) => s.overrides[urn]);
  const [url, setUrl] = useState('');
  const [busyFile, setBusyFile] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const trackArts = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const track of tracks) {
      const art = track.artwork_url;
      if (art && !seen.has(art)) {
        seen.add(art);
        out.push(art);
      }
    }
    return out.slice(0, 24);
  }, [tracks]);

  const apply = (value: string) => {
    usePlaylistArtworkStore.getState().setArtwork(urn, value);
    toast.success(t('playlist.artworkSaved'));
    onOpenChange(false);
  };

  const handleUrl = () => {
    const value = url.trim();
    if (!looksLikeImageUrl(value)) return;
    apply(value);
    setUrl('');
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusyFile(true);
    try {
      apply(await fileToCoverDataUrl(file));
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusyFile(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleReset = () => {
    usePlaylistArtworkStore.getState().clearArtwork(urn);
    toast.success(t('playlist.artworkSaved'));
    onOpenChange(false);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="sm" showClose={false} zClass="z-[90]">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <ModalTitle className="text-[15px] font-bold text-white/90 flex items-center gap-2">
            <ImagePlus size={18} />
            {t('playlist.changeArtwork')}
          </ModalTitle>
          <ModalClose className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-all">
            <X size={14} />
          </ModalClose>
        </div>

        <div className="px-5 pb-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 ring-1 ring-white/[0.08] bg-white/[0.03] flex items-center justify-center">
              {current ? (
                <img src={current} alt="" className="w-full h-full object-cover" />
              ) : (
                <ImagePlus size={20} className="text-white/20" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-white/45 leading-snug">
                {current ? t('playlist.artworkCustom') : t('playlist.artworkDefault')}
              </p>
              {current && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="mt-1 text-[12px] font-medium text-white/40 hover:text-white/75 transition-colors cursor-pointer"
                >
                  {t('playlist.artworkReset')}
                </button>
              )}
            </div>
          </div>

          {trackArts.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35 mb-2">
                {t('playlist.artworkFromTracks')}
              </p>
              <div className="grid grid-cols-6 gap-2">
                {trackArts.map((art) => (
                  <button
                    key={art}
                    type="button"
                    onClick={() => apply(art)}
                    className={`rounded-lg overflow-hidden ring-1 transition-all cursor-pointer aspect-square ${
                      current === art ? 'ring-accent' : 'ring-white/[0.08] hover:ring-white/30'
                    }`}
                  >
                    <img src={art} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35 mb-2">
              {t('playlist.artworkUrlLabel')}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleUrl();
                }}
                placeholder={t('playlist.artworkUrlPh')}
                spellCheck={false}
                className="flex-1 min-w-0 bg-white/[0.04] text-[13px] text-white/90 placeholder:text-white/25 px-3 py-2 rounded-lg outline-none border border-white/[0.06] focus:border-accent/30 transition-colors"
              />
              <button
                type="button"
                onClick={handleUrl}
                disabled={!looksLikeImageUrl(url.trim())}
                className="px-3.5 py-2 rounded-lg text-[12px] font-semibold bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 transition-all cursor-pointer disabled:cursor-not-allowed shrink-0"
              >
                {t('playlist.artworkApply')}
              </button>
            </div>
          </div>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busyFile}
              className="w-full px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-[13px] font-medium text-white/70 border border-white/[0.06] transition-all cursor-pointer disabled:opacity-40"
            >
              {busyFile ? t('common.loading') : t('playlist.artworkPickFile')}
            </button>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
});

/** Self-contained cover-edit button + dialog for playlist headers. */
export const PlaylistArtworkButton = React.memo(function PlaylistArtworkButton({
  urn,
  tracks,
  className,
}: {
  urn: string;
  tracks: Pick<Track, 'urn' | 'artwork_url'>[];
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('playlist.changeArtwork')}
        aria-label={t('playlist.changeArtwork')}
        className={
          className ??
          'inline-flex items-center justify-center w-10 h-10 rounded-xl text-white/60 hover:text-white/95 hover:bg-white/[0.07] transition-all duration-200 cursor-pointer'
        }
      >
        <ImagePlus size={16} />
      </button>
      <PlaylistArtworkDialog urn={urn} tracks={tracks} open={open} onOpenChange={setOpen} />
    </>
  );
});
