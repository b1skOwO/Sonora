import { useTranslation } from 'react-i18next';
import { Download } from '../../../lib/icons';
import { useUpdaterStore } from '../../../lib/sonora-update';
import { useSettingsStore } from '../../../stores/settings';
import { Card, Row, Toggle } from '../primitives';

export function UpdatesCard() {
  const { t } = useTranslation();
  const autoCheckUpdates = useSettingsStore((s) => s.autoCheckUpdates);
  const setAutoCheckUpdates = useSettingsStore((s) => s.setAutoCheckUpdates);
  const checking = useUpdaterStore((s) => s.checking);
  const installing = useUpdaterStore((s) => s.installing);
  const upToDate = useUpdaterStore((s) => s.upToDate);
  const error = useUpdaterStore((s) => s.error);
  const checkNow = useUpdaterStore((s) => s.checkNow);

  const status = checking
    ? t('common.loading')
    : installing
      ? t('update.installing')
      : error
        ? t(`update.${error}`)
        : upToDate
          ? t('update.upToDate')
          : null;

  return (
    <Card
      title={t('settings.updates')}
      desc={t('settings.updatesDesc')}
      icon={<Download size={17} />}
    >
      <Row title={t('update.autoCheck')} desc={t('update.autoCheckDesc')}>
        <Toggle
          checked={autoCheckUpdates}
          onChange={() => setAutoCheckUpdates(!autoCheckUpdates)}
        />
      </Row>
      <div className="flex items-center gap-3 pt-3">
        <button
          type="button"
          disabled={checking || installing}
          onClick={() => void checkNow({ resetDismissal: true })}
          className="px-5 py-2 rounded-xl bg-accent/20 hover:bg-accent/30 text-[13px] font-semibold text-accent border border-accent/20 transition-all cursor-pointer disabled:opacity-30"
        >
          {t('update.checkNow')}
        </button>
        {status && <span className="text-[12px] text-white/35">{status}</span>}
      </div>
    </Card>
  );
}
