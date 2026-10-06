import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { proxiedAssetUrl } from '../../lib/asset-url';
import { formatTime } from '../../lib/formatters';
import { Disc3, Pause, Play, RotateCcw, X } from '../../lib/icons';
import { useDjStore } from '../../stores/dj';
import { usePlayerStore, type Track } from '../../stores/player';

const BUTTON_CLASS =
  'px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.06] text-white/70 hover:bg-white/[0.1] border border-white/[0.06] hover:border-white/[0.12] transition-all cursor-pointer';

function DeckCard({ index }: { index: 0 | 1 }) {
  const { t } = useTranslation();
  const deck = useDjStore((s) => s.decks[index]);
  const loadTrack = useDjStore((s) => s.loadTrack);
  const unload = useDjStore((s) => s.unload);
  const togglePlay = useDjStore((s) => s.togglePlay);
  const seek = useDjStore((s) => s.seek);
  const setVolume = useDjStore((s) => s.setVolume);
  const setSpeed = useDjStore((s) => s.setSpeed);
  const setEq = useDjStore((s) => s.setEq);
  const setLoopPoint = useDjStore((s) => s.setLoopPoint);
  const clearLoop = useDjStore((s) => s.clearLoop);
  const [picking, setPicking] = useState(false);

  const current = usePlayerStore((s) => s.currentTrack);
  const queue = usePlayerStore((s) => s.queue);
  const pickList = useMemo(() => {
    const seen = new Set<string>();
    const list: Track[] = [];
    for (const track of [current, ...queue]) {
      if (!track || seen.has(track.urn)) continue;
      seen.add(track.urn);
      list.push(track);
    }
    return list;
  }, [current, queue]);

  const duration = deck.duration ?? 0;
  const progress = duration > 0 ? Math.min(100, (deck.position / duration) * 100) : 0;
  const speedPct = Math.round((deck.speed - 1) * 100);

  return (
    <section className="relative rounded-[1.75rem] border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.24em] text-white/50">
          <Disc3 size={13} />
          {index === 0 ? t('dj.deckA') : t('dj.deckB')}
        </span>
        {deck.loaded && (
          <button
            type="button"
            onClick={() => unload(index)}
            title={t('dj.unload')}
            aria-label={t('dj.unload')}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-all cursor-pointer"
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <div className="w-16 h-16 rounded-xl overflow-hidden bg-white/[0.05] border border-white/[0.06] shrink-0">
          {deck.track?.artwork_url ? (
            <img
              src={proxiedAssetUrl(deck.track.artwork_url) ?? ''}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Disc3 size={22} className="text-white/20" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {deck.loading ? (
            <p className="text-[13px] text-white/50">{t('dj.loading')}</p>
          ) : deck.track ? (
            <>
              <p className="text-[14px] font-semibold text-white/90 truncate">
                {deck.track.title}
              </p>
              <p className="text-[12px] text-white/40 truncate">{deck.track.user?.username}</p>
            </>
          ) : (
            <p className="text-[13px] text-white/35">{t('dj.noTrack')}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className={`${BUTTON_CLASS} shrink-0`}
        >
          {t('dj.load')}
        </button>
      </div>

      {picking && (
        <div className="rounded-xl border border-white/[0.08] bg-black/30 max-h-56 overflow-y-auto">
          {pickList.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-white/35">{t('dj.pickEmpty')}</p>
          ) : (
            pickList.map((track) => (
              <button
                key={track.urn}
                type="button"
                onClick={() => {
                  setPicking(false);
                  void loadTrack(index, track);
                }}
                className="w-full text-left px-3 py-2 hover:bg-white/[0.06] transition-colors cursor-pointer"
              >
                <p className="text-[12px] text-white/80 truncate">{track.title}</p>
                <p className="text-[11px] text-white/35 truncate">{track.user?.username}</p>
              </button>
            ))
          )}
        </div>
      )}

      <div>
        <div
          className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            if (duration > 0) seek(index, pct * duration);
          }}
        >
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-white/35 tabular-nums">
          <span>{formatTime(deck.position)}</span>
          <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => seek(index, 0)}
          title={t('dj.cue')}
          aria-label={t('dj.cue')}
          className="w-10 h-10 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] transition-all cursor-pointer"
        >
          <RotateCcw size={16} />
        </button>
        <button
          type="button"
          onClick={() => togglePlay(index)}
          disabled={!deck.loaded}
          className="w-14 h-14 rounded-full flex items-center justify-center bg-white text-black cursor-pointer disabled:opacity-30 hover:scale-[1.03] active:scale-95 transition-transform"
        >
          {deck.playing ? (
            <Pause size={22} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={22} fill="currentColor" strokeWidth={0} className="ml-0.5" />
          )}
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-white/45">
          <span className="uppercase tracking-[0.18em] font-bold">{t('dj.tempo')}</span>
          <span className="tabular-nums">
            {speedPct > 0 ? `+${speedPct}%` : `${speedPct}%`}
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.01}
          value={deck.speed}
          onChange={(e) => setSpeed(index, Number(e.target.value))}
          className="w-full accent-[var(--color-accent)] cursor-pointer"
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(['dj.eqLow', 'dj.eqMid', 'dj.eqHigh'] as const).map((key, band) => (
          <div key={key} className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-white/40">
              <span className="uppercase tracking-wider">{t(key)}</span>
              <span className="tabular-nums">
                {deck.eq[band] > 0 ? '+' : ''}
                {deck.eq[band].toFixed(0)}
              </span>
            </div>
            <input
              type="range"
              min={-12}
              max={12}
              step={0.5}
              value={deck.eq[band]}
              onChange={(e) => setEq(index, band as 0 | 1 | 2, Number(e.target.value))}
              className="w-full accent-[var(--color-accent)] cursor-pointer"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-white/45 uppercase tracking-[0.18em] font-bold">
          {t('dj.loop')}
        </span>
        <button type="button" onClick={() => setLoopPoint(index, 'a')} className={BUTTON_CLASS}>
          {t('dj.setA')}
        </button>
        <button type="button" onClick={() => setLoopPoint(index, 'b')} className={BUTTON_CLASS}>
          {t('dj.setB')}
        </button>
        {(deck.loopA != null || deck.loopB != null) && (
          <button
            type="button"
            onClick={() => clearLoop(index)}
            title={t('dj.clearLoop')}
            aria-label={t('dj.clearLoop')}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/35 hover:text-white/70 hover:bg-white/[0.06] transition-all cursor-pointer"
          >
            <X size={12} />
          </button>
        )}
        {deck.loopA != null && deck.loopB != null && (
          <span className="text-[10px] text-[var(--color-accent)] tabular-nums ml-auto">
            {formatTime(deck.loopA)} – {formatTime(deck.loopB)}
          </span>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px] text-white/45">
          <span className="uppercase tracking-[0.18em] font-bold">{t('dj.volume')}</span>
          <span className="tabular-nums">{Math.round(deck.volume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={deck.volume}
          onChange={(e) => setVolume(index, Number(e.target.value))}
          className="w-full accent-[var(--color-accent)] cursor-pointer"
        />
      </div>
    </section>
  );
}

/** Full-screen DJ overlay: two decks + crossfader. */
export function DjPanel() {
  const { t } = useTranslation();
  const open = useDjStore((s) => s.open);
  const closePanel = useDjStore((s) => s.closePanel);
  const crossfade = useDjStore((s) => s.crossfade);
  const setCrossfade = useDjStore((s) => s.setCrossfade);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex flex-col bg-[#08080b]/95 backdrop-blur-2xl"
      style={{ isolation: 'isolate' }}
    >
      <header className="flex items-center justify-between px-5 md:px-8 py-4 border-b border-white/[0.06]">
        <span className="inline-flex items-center gap-2.5 text-[15px] font-bold text-white/90">
          <Disc3 size={18} className="text-[var(--color-accent)]" />
          {t('dj.title')}
        </span>
        <button
          type="button"
          onClick={closePanel}
          title={t('dj.close')}
          aria-label={t('dj.close')}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white/45 hover:text-white hover:bg-white/[0.06] transition-all cursor-pointer"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-[1400px] mx-auto grid gap-4 lg:grid-cols-[1fr_minmax(180px,240px)_1fr] items-start">
          <DeckCard index={0} />

          <div className="rounded-[1.75rem] border border-white/[0.08] bg-white/[0.03] p-5 backdrop-blur-xl flex flex-col gap-4">
            <span className="text-[11px] font-bold uppercase tracking-[0.24em] text-white/50 text-center">
              {t('dj.crossfade')}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-white/40">A</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={crossfade}
                onChange={(e) => setCrossfade(Number(e.target.value))}
                className="flex-1 accent-[var(--color-accent)] cursor-pointer"
              />
              <span className="text-[11px] font-bold text-white/40">B</span>
            </div>
            <p className="text-[11px] text-white/30 leading-relaxed text-center">
              {t('dj.masterNote')}
            </p>
          </div>

          <DeckCard index={1} />
        </div>
      </div>
    </div>
  );
}

export default DjPanel;
