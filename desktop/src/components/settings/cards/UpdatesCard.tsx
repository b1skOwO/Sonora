import { useTranslation } from 'react-i18next';
import { Download } from '../../../lib/icons';
import { useUpdaterStore } from '../../../lib/sonora-update';
import { useSettingsStore } from '../../../stores/settings';
import { Card, Row, Toggle } from '../primitives';

export function UpdatesCard() {
  const { t } = useTranslation();
  const githubPat = useSettingsStore((s) => s.githubPat);
  const setGithubPat = useSettingsStore((s) => s.setGithubPat);
  const autoCheckUpdates = useSettingsStore((s) => s.autoCheckUpdates);
  const setAutoCheckUpdates = useSettingsStore((s) => s.setAutoCheckUpdates);
  const checking = useUpdaterStore((s) => s.checking);
  const upToDate = useUpdaterStore((s) => s.upToDate);
  const error = useUpdaterStore((s) => s.error);
  const checkNow = useUpdaterStore((s) => s.checkNow);

  const status = checking
    ? t('common.loading')
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
      <div className="py-3">
        <p className="text-[13.5px] text-white/80 font-medium">{t('update.tokenLabel')}</p>
        <p className="text-[11.5px] text-white/35 mt-0.5 leading-snug">{t('update.tokenDesc')}</p>
        <input
          type="password"
          value={githubPat}
          onChange={(e) => setGithubPat(e.target.value.trim())}
          placeholder={t('update.tokenPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className="mt-2 w-full bg-white/[0.04] text-[13px] text-white/90 placeholder:text-white/25 px-3 py-2 rounded-lg outline-none border border-white/[0.06] focus:border-white/[0.14] transition-colors"
        />
      </div>
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          disabled={checking || githubPat.trim().length === 0}
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
