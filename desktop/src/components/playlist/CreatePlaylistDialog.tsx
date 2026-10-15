import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useCreatePlaylist } from '../../lib/hooks';
import { Globe, ListPlus, Lock, Plus, X } from '../../lib/icons';
import { newSonoraPlaylist, useLocalPlaylistsStore } from '../../stores/local-playlists';
import { useServiceStore } from '../../stores/service';
import { Modal, ModalContent, ModalTitle } from '../ui/Modal';

function formatError(error: unknown): string {
  const raw =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

/**
 * Create a playlist from the Library. Service-aware: in SoundCloud mode it
 * creates a real playlist on SoundCloud (private/public), in YouTube mode it
 * creates a local one that lives in the app and is filled with YouTube tracks
 * from its own page. Either way we land on the fresh playlist afterwards.
 */
export const CreatePlaylistDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const service = useServiceStore((s) => s.service);
  const isLocal = service === 'youtube';
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const createPlaylist = useCreatePlaylist();

  // Fresh state for every open.
  useEffect(() => {
    if (!open) {
      setName('');
      setIsPrivate(false);
    }
  }, [open]);

  const pending = createPlaylist.isPending;

  const handleSubmit = useCallback(() => {
    const title = name.trim();
    if (!title || pending) return;

    if (isLocal) {
      const playlist = newSonoraPlaylist(title);
      useLocalPlaylistsStore.getState().upsert(playlist);
      toast.success(t('playlist.created'));
      onOpenChange(false);
      navigate(`/playlist/${encodeURIComponent(playlist.id)}`);
      return;
    }

    createPlaylist.mutate(
      { title, sharing: isPrivate ? 'private' : 'public' },
      {
        onSuccess: (playlist) => {
          toast.success(t('playlist.created'));
          onOpenChange(false);
          if (playlist?.urn) navigate(`/playlist/${encodeURIComponent(playlist.urn)}`);
        },
        onError: (error) => toast.error(formatError(error)),
      },
    );
  }, [name, pending, isLocal, isPrivate, createPlaylist, onOpenChange, navigate, t]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="sm" showClose={false} zClass="z-[90]">
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <ModalTitle className="text-[15px] font-bold text-white/90 flex items-center gap-2">
            <ListPlus size={18} />
            {t('playlist.newPlaylist')}
          </ModalTitle>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.08] transition-all cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder={t('playlist.playlistName')}
            className="w-full bg-white/[0.04] text-[13px] text-white/90 placeholder:text-white/25 px-3 py-2.5 rounded-lg outline-none border border-white/[0.06] focus:border-accent/30 transition-colors"
            autoFocus
            disabled={pending}
          />

          {isLocal ? (
            <p className="text-[11px] leading-snug text-white/35">
              {t('playlist.localPlaylistHint')}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setIsPrivate((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white/60 transition-colors cursor-pointer"
            >
              {isPrivate ? <Lock size={12} /> : <Globe size={12} />}
              {isPrivate ? t('playlist.private') : t('playlist.public')}
            </button>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-xl text-[13px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.06] transition-all cursor-pointer"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!name.trim() || pending}
              className="px-4 py-2 rounded-xl text-[13px] font-semibold bg-accent text-accent-contrast hover:bg-accent-hover disabled:opacity-40 transition-all cursor-pointer disabled:cursor-not-allowed"
            >
              {pending ? t('playlist.creating') : t('playlist.create')}
            </button>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
};

/** Dashed "new playlist" card for the Library playlists racks. */
export const CreatePlaylistTile = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group w-[160px] shrink-0 flex flex-col gap-3 cursor-pointer text-left"
      >
        <div className="aspect-square rounded-2xl border border-dashed border-white/[0.14] bg-white/[0.02] group-hover:bg-white/[0.05] group-hover:border-accent/40 transition-all duration-300 flex items-center justify-center">
          <span className="w-12 h-12 rounded-full bg-white/[0.05] ring-1 ring-white/[0.08] flex items-center justify-center text-white/50 group-hover:text-accent group-hover:bg-accent/10 group-hover:ring-accent/20 transition-colors">
            <Plus size={20} />
          </span>
        </div>
        <div className="min-w-0 px-1">
          <p className="text-[14px] font-semibold text-white/75 group-hover:text-white truncate leading-snug transition-colors">
            {t('playlist.newPlaylist')}
          </p>
        </div>
      </button>
      <CreatePlaylistDialog open={open} onOpenChange={setOpen} />
    </>
  );
};

/** Compact "new playlist" action for the playlists page header. */
export const CreatePlaylistButton = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[12.5px] font-semibold text-white/70 hover:text-white/90 transition-all cursor-pointer shrink-0"
      >
        <Plus size={14} />
        {t('playlist.newPlaylist')}
      </button>
      <CreatePlaylistDialog open={open} onOpenChange={setOpen} />
    </>
  );
};
