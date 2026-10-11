import { useTranslation } from 'react-i18next';
import { Gauge } from '../../../lib/icons';
import { useSettingsStore } from '../../../stores/settings';
import { Card, Row, Toggle } from '../primitives';

/** WebView2 memory controls. Both toggles are read once at startup (they turn
 *  into browser arguments), so they apply after a restart. The automatic
 *  minimize/hide trim needs no setting. */
export function MemoryCard() {
  const { t } = useTranslation();
  const memorySaver = useSettingsStore((s) => s.memorySaver);
  const disableGpu = useSettingsStore((s) => s.disableGpu);
  const setMemorySaver = useSettingsStore((s) => s.setMemorySaver);
  const setDisableGpu = useSettingsStore((s) => s.setDisableGpu);

  return (
    <Card title={t('settings.memory')} desc={t('settings.memoryDesc')} icon={<Gauge size={17} />}>
      <div className="divide-y divide-white/[0.05]">
        <Row title={t('settings.memorySaver')} desc={t('settings.memorySaverDesc')}>
          <Toggle checked={memorySaver} onChange={() => setMemorySaver(!memorySaver)} />
        </Row>
        <Row title={t('settings.disableGpu')} desc={t('settings.disableGpuDesc')}>
          <Toggle checked={disableGpu} onChange={() => setDisableGpu(!disableGpu)} />
        </Row>
      </div>
      <p className="text-[11.5px] text-white/35 mt-3 leading-snug">
        {t('settings.memoryRestartNote')}
      </p>
      <p className="text-[11.5px] text-white/35 mt-1 leading-snug">
        {t('settings.memoryMinimizeNote')}
      </p>
    </Card>
  );
}
