import { Cloud, Sparkles, Type } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchPrefsStore } from '../../stores/searchPrefs';

/* The search-page control row: Text / Vibe mode + the SoundCloud (live) source
 * toggle. The query itself lives in the global header field — this is just how
 * the current query is interpreted. */
export const SearchControls = memo(function SearchControls() {
  const { t } = useTranslation();
  const mode = useSearchPrefsStore((s) => s.mode);
  const setMode = useSearchPrefsStore((s) => s.setMode);
  const source = useSearchPrefsStore((s) => s.source);
  const setSource = useSearchPrefsStore((s) => s.setSource);

  const pickMode = (m: 'text' | 'vibe') => {
    setMode(m);
    setSource('db');
  };

  return (
    <div className="flex items-center justify-center gap-1.5">
      <div
        className={`flex items-center gap-0.5 p-0.5 rounded-full bg-white/[0.04] border border-white/10 transition-opacity duration-300 ${
          source === 'sc' ? 'opacity-40' : ''
        }`}
      >
        <Pill
          active={mode === 'text' && source === 'db'}
          onClick={() => pickMode('text')}
          icon={<Type size={13} />}
          label={t('search.mode.text')}
        />
        <Pill
          active={mode === 'vibe' && source === 'db'}
          onClick={() => pickMode('vibe')}
          icon={<Sparkles size={13} />}
          label={t('search.mode.vibe')}
        />
      </div>
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

function Pill({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[12px] font-medium transition-all duration-300 cursor-pointer"
      style={
        active
          ? {
              color: '#fff',
              background: 'rgba(255,255,255,0.06)',
              boxShadow:
                'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent), inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.4)',
            }
          : { color: 'rgba(255,255,255,0.45)' }
      }
    >
      {icon}
      {label}
    </button>
  );
}
