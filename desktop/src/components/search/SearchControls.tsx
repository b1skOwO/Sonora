import { Cloud } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchPrefsStore } from '../../stores/searchPrefs';

/* The search-page control row: the SoundCloud (live) source toggle. The query
 * itself lives in the global header field — this is just how the current
 * query is interpreted. */
export const SearchControls = memo(function SearchControls() {
  const { t } = useTranslation();
  const source = useSearchPrefsStore((s) => s.source);
  const setSource = useSearchPrefsStore((s) => s.setSource);

  return (
    <div className="flex items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={() => setSource(source === 'sc' ? 'db' : 'sc')}
        title={t('search.source.scHint')}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-[12px] font-medium transition-all duration-300 cursor-pointer"
        style={
          source === 'sc'
            ? {
                color: '#fff',
                background: 'rgba(255,255,255,0.06)',
                border: '0.5px solid color-mix(in srgb, var(--color-accent) 55%, transparent)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.4)',
              }
            : {
                color: 'rgba(255,255,255,0.45)',
                background: 'rgba(255,255,255,0.04)',
                border: '0.5px solid rgba(255,255,255,0.1)',
              }
        }
      >
        <Cloud size={13} />
        {t('search.source.sc')}
      </button>
    </div>
  );
});
