import { useTranslation } from 'react-i18next';
import { AudioLines } from '../../../lib/icons';
import { EqualizerPanel } from '../../music/EqualizerPanel';
import { Card, Row } from '../primitives';

/** Settings entry point for the 10-band equalizer (same modal as the player bar). */
export function EqualizerCard() {
  const { t } = useTranslation();
  return (
    <Card title={t('eq.title')} desc={t('settings.eqDesc')} icon={<AudioLines size={17} />}>
      <Row title={t('eq.streamingNote')}>
        <EqualizerPanel>
          <button
            type="button"
            className="h-10 px-4 rounded-xl bg-accent text-accent-contrast text-[12.5px] font-semibold transition-colors hover:bg-accent-hover active:scale-[0.97] cursor-pointer"
            style={{
              boxShadow: '0 10px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.25)',
            }}
          >
            {t('settings.eqOpen')}
          </button>
        </EqualizerPanel>
      </Row>
    </Card>
  );
}
