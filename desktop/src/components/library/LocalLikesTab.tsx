import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useUnifiedLikes } from '../../stores/local-likes';
import { VirtualList } from '../ui/VirtualList';
import { LibraryTrackRow } from './LibraryTrackRow';

/** The unified likes playlist: local hearts (mostly YouTube) + backend
 *  SoundCloud likes, deduped. Playable as one queue. Filterable,
 *  virtualized, no extra fetching beyond the shared likes query. */
export const LocalLikesTab = React.memo(function LocalLikesTab({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const tracks = useUnifiedLikes();

  const filtered = useMemo(() => {
    if (!filter) return tracks;
    const q = filter.toLowerCase();
    return tracks.filter(
      (tr) => tr.title.toLowerCase().includes(q) || tr.user.username.toLowerCase().includes(q),
    );
  }, [tracks, filter]);

  return (
    <div className="min-h-[400px]">
      <div className="flex flex-col gap-1">
        {filtered.length > 0 ? (
          <VirtualList
            items={filtered}
            rowHeight={68}
            overscan={8}
            className="flex flex-col gap-1"
            disabled={filtered.length < 40}
            getItemKey={(track) => track.urn}
            renderItem={(track, i) => <LibraryTrackRow track={track} index={i} queue={filtered} />}
          />
        ) : (
          <div className="py-20 text-center text-white/20">
            {filter ? t('library.noMatches') : t('library.noLocalLikes')}
          </div>
        )}
      </div>
    </div>
  );
});
