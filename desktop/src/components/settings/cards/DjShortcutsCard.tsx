import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard } from '../../../lib/icons';
import {
  DJ_ACTIONS,
  type DjActionId,
  formatKeyCode,
  useKeybindingsStore,
} from '../../../stores/keybindings';
import { Card, Divider } from '../primitives';

/**
 * Keys that can never start a binding: Escape cancels the capture, Tab keeps
 * focus navigation intact, F11 keeps fullscreen sacred, pure modifiers and
 * modifier-held presses are ignored so a stored code always fires bare.
 */
function isForbiddenCapture(e: KeyboardEvent): boolean {
  return (
    e.code === 'Tab' ||
    e.code === 'F11' ||
    e.code === 'ShiftLeft' ||
    e.code === 'ShiftRight' ||
    e.code === 'ControlLeft' ||
    e.code === 'ControlRight' ||
    e.code === 'AltLeft' ||
    e.code === 'AltRight' ||
    e.code === 'MetaLeft' ||
    e.code === 'MetaRight' ||
    e.metaKey ||
    e.ctrlKey ||
    e.altKey
  );
}

function KeyButton({
  actionKey,
  capturing,
  onStart,
}: {
  actionKey: string;
  capturing: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onStart}
      title={capturing ? t('settings.djPressKey') : actionKey}
      className={`inline-flex items-center justify-center min-w-[64px] h-8 px-2.5 rounded-lg border text-[12px] font-semibold font-mono transition-all cursor-pointer ${
        capturing
          ? 'bg-accent/20 border-accent/40 text-accent animate-pulse'
          : 'bg-white/[0.06] border-white/[0.1] text-white/70 hover:bg-white/[0.1] hover:border-white/[0.16]'
      }`}
    >
      {capturing ? t('settings.djPressKey') : actionKey}
    </button>
  );
}

export function DjShortcutsCard() {
  const { t } = useTranslation();
  const bindings = useKeybindingsStore((s) => s.bindings);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const resetBindings = useKeybindingsStore((s) => s.resetBindings);
  const [capturing, setCapturing] = useState<DjActionId | null>(null);

  // Capture runs in the capture phase and swallows the key so the global
  // shortcuts (and the DJ dispatcher itself) don't react to it.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setCapturing(null);
        return;
      }
      if (isForbiddenCapture(e)) return;
      setBinding(capturing, e.code);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, setBinding]);

  const groups: Array<{ titleKey: string; ids: DjActionId[] }> = [
    { titleKey: 'dj.deckA', ids: ['deckA.play', 'deckA.cue', 'deckA.sync'] },
    { titleKey: 'dj.deckB', ids: ['deckB.play', 'deckB.cue', 'deckB.sync'] },
    { titleKey: 'dj.crossfade', ids: ['xfader.left', 'xfader.right', 'automix.toggle'] },
  ];

  return (
    <Card
      title={t('settings.djKeys')}
      desc={t('settings.djKeysDesc')}
      icon={<Keyboard size={17} />}
    >
      {groups.map((group, groupIndex) => (
        <div key={group.titleKey}>
          {groupIndex > 0 && (
            <div className="py-2">
              <Divider />
            </div>
          )}
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/35 pt-1 pb-2">
            {t(group.titleKey)}
          </p>
          <div className="space-y-1">
            {group.ids.map((id) => {
              const def = DJ_ACTIONS.find((a) => a.id === id);
              if (!def) return null;
              return (
                <div key={id} className="flex items-center justify-between gap-4 py-1.5">
                  <span className="text-[13px] text-white/70">{t(def.labelKey)}</span>
                  <KeyButton
                    actionKey={formatKeyCode(bindings[id])}
                    capturing={capturing === id}
                    onStart={() => setCapturing(id)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-4">
        <button
          type="button"
          onClick={resetBindings}
          className="px-5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-[13px] font-semibold text-white/60 border border-white/[0.08] transition-all cursor-pointer"
        >
          {t('settings.djReset')}
        </button>
        {capturing && (
          <button
            type="button"
            onClick={() => setCapturing(null)}
            className="text-[12px] text-white/35 hover:text-white/60 transition-colors cursor-pointer"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </Card>
  );
}
