import { useQueryClient } from '@tanstack/react-query';
import React, { useEffect } from 'react';
import { api } from '../../lib/api';
import { invalidateAllLikesCache } from '../../lib/hooks';
import { Heart } from '../../lib/icons';
import { optimisticToggleLike, setLikedUrn, useLiked } from '../../lib/likes';
import { isYoutubeUrn } from '../../lib/youtube';
import { useLocalLiked, useLocalLikesStore } from '../../stores/local-likes';
import type { Track } from '../../stores/player';

function HeartButton({
  filled,
  onToggle,
  variant,
}: {
  filled: boolean;
  onToggle: (e: React.MouseEvent) => void;
  variant: 'overlay' | 'inline';
}) {
  if (variant === 'overlay') {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={`cursor-pointer absolute top-2 left-2 w-8 h-8 rounded-full backdrop-blur-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 ${
          filled
            ? 'bg-accent/80 text-accent-contrast'
            : 'bg-black/50 text-white/80 hover:text-white hover:bg-black/70'
        }`}
      >
        <Heart size={14} fill={filled ? 'currentColor' : 'none'} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`cursor-pointer w-8 h-8 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 shrink-0 ${
        filled ? 'text-accent' : 'text-white/20 hover:text-white/50'
      }`}
    >
      <Heart size={14} fill={filled ? 'currentColor' : 'none'} />
    </button>
  );
}

/** Backend-independent heart for YouTube tracks — feeds the local-likes playlist. */
const LocalLikeButton = React.memo(function LocalLikeButton({
  track,
  variant = 'inline',
}: {
  track: Track;
  variant?: 'overlay' | 'inline';
}) {
  const liked = useLocalLiked(track.urn);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    useLocalLikesStore.getState().toggle(track);
  };
  return <HeartButton filled={liked} onToggle={toggle} variant={variant} />;
});

export const LikeButton = React.memo(function LikeButton({
  track,
  variant = 'inline',
}: {
  track: Track;
  variant?: 'overlay' | 'inline';
}) {
  const liked = useLiked(track.urn);

  // Seed from API data when available
  useEffect(() => {
    if (track.user_favorite) setLikedUrn(track.urn, true);
  }, [track.urn, track.user_favorite]);
  const qc = useQueryClient();

  // YouTube tracks have no backend id — their hearts live in local likes.
  if (isYoutubeUrn(track.urn)) return <LocalLikeButton track={track} variant={variant} />;

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !liked;
    optimisticToggleLike(qc, track, next);
    invalidateAllLikesCache();
    try {
      await api(`/likes/tracks/${encodeURIComponent(track.urn)}`, {
        method: next ? 'POST' : 'DELETE',
        body: next ? JSON.stringify(track) : undefined,
      });
    } catch {
      optimisticToggleLike(qc, track, !next);
    }
  };

  if (variant === 'overlay') {
    return <HeartButton filled={liked} onToggle={toggle} variant={variant} />;
  }

  return <HeartButton filled={liked} onToggle={toggle} variant={variant} />;
});
