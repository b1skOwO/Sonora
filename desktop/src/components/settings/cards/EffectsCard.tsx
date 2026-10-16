import { useTranslation } from 'react-i18next';
import { Sparkles } from '../../../lib/icons';
import { useSettingsStore } from '../../../stores/settings';
import { Card, RangeSlider, Row } from '../primitives';

function EffectSlider({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-3">
      <Row title={label} desc={desc}>
        <span className="text-[12px] font-semibold tabular-nums text-white/70">{value}%</span>
      </Row>
      <RangeSlider value={value} min={0} max={150} step={5} onChange={onChange} />
    </div>
  );
}

/** Accent-glow intensity slider. `100%` keeps the tuned default look. */
export function EffectsCard() {
  const { t } = useTranslation();
  const glowStrength = useSettingsStore((s) => s.glowStrength);
  const setGlowStrength = useSettingsStore((s) => s.setGlowStrength);

  return (
    <Card
      title={t('settings.effects')}
      desc={t('settings.effectsDesc')}
      icon={<Sparkles size={17} />}
    >
      <EffectSlider
        label={t('settings.glowStrength')}
        desc={t('settings.glowStrengthDesc')}
        value={glowStrength}
        onChange={setGlowStrength}
      />
    </Card>
  );
}
