import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { switchAudioDevice } from '../../../lib/audio';
import { trackedInvoke } from '../../../lib/diagnostics';
import { Volume2 } from '../../../lib/icons';
import { Card } from '../primitives';

interface AudioSink {
  name: string;
  description: string;
  is_default: boolean;
}

export function AudioDeviceCard() {
  const { t } = useTranslation();
  const [sinks, setSinks] = useState<AudioSink[]>([]);
  const [switching, setSwitching] = useState(false);

  const refreshSinks = useCallback(() => {
    trackedInvoke<AudioSink[]>('audio_list_devices').then(setSinks).catch(console.error);
  }, []);

  useEffect(() => {
    refreshSinks();
    const onFocus = () => refreshSinks();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshSinks]);

  const handleSwitch = async (sinkName: string) => {
    const current = sinks.find((s) => s.is_default);
    if (switching || current?.name === sinkName) return;
    setSwitching(true);
    try {
      await switchAudioDevice(sinkName, true);
      setSinks((prev) => prev.map((s) => ({ ...s, is_default: s.name === sinkName })));
      toast.success(t('settings.audioDeviceSwitched'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSwitching(false);
    }
  };

  if (sinks.length === 0) return null;

  return (
    <Card title={t('settings.audioDevice')} icon={<Volume2 size={17} />}>
      <div className="flex gap-2 flex-wrap">
        {sinks.map((sink) => (
          <button
            key={sink.name}
            type="button"
            onClick={() => handleSwitch(sink.name)}
            disabled={switching}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-200 border ${
              sink.is_default
                ? // Selected device: accent-tinted and unmistakable. A plain
                  // white glow looked identical to a stuck :hover (which
                  // lingers until the next scroll) — that was the
                  // "weird glow that vanishes on scroll".
                  'bg-accent/[0.14] text-white/90 border-accent/40 cursor-default'
                : 'bg-white/[0.02] text-white/40 border-white/[0.05] hover:bg-white/[0.06] hover:text-white/60 cursor-pointer'
            } disabled:opacity-50`}
          >
            {sink.is_default && (
              <span
                aria-hidden
                className="size-1.5 rounded-full shrink-0"
                style={{ background: 'var(--color-accent)' }}
              />
            )}
            {sink.description}
          </button>
        ))}
      </div>
    </Card>
  );
}
