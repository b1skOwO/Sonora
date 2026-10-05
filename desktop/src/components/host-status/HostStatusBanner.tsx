import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/shallow';
import { useHostStatusStore } from '../../lib/host-status';
import { X } from '../../lib/icons';
import { useFailoverUi } from './useFailoverUi';

// Flat dark tint, no backdrop-filter.
const PILL_STYLE: React.CSSProperties = {
  background: 'rgba(18,18,22,0.94)',
  border: '0.5px solid rgba(255,255,255,0.12)',
  boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.12), 0 8px 24px rgba(0,0,0,0.45)',
};

export const HostStatusBanner = React.memo(() => {
  const { t } = useTranslation();
  const ui = useFailoverUi();
  const { incidentId, modalDismissedIncidentId } = useHostStatusStore(
    useShallow((s) => ({
      incidentId: s.incidentId,
      modalDismissedIncidentId: s.modalDismissedIncidentId,
    })),
  );
  const reopenModal = useHostStatusStore((s) => s.reopenModal);

  const outageDismissed = ui === 'all-down' && modalDismissedIncidentId === incidentId;
  if (!outageDismissed) return null;

  return (
    <div
      className="fixed top-12 left-1/2 -translate-x-1/2 z-[60] pointer-events-auto flex items-center gap-2 max-w-[calc(100vw-32px)] rounded-full pl-3.5 pr-2 py-1.5"
      style={PILL_STYLE}
    >
      <span className="min-w-0 truncate text-[11.5px] font-medium text-white/85">
        {t('hostStatus.banner.outage')}
      </span>
      <button
        type="button"
        onClick={reopenModal}
        className="shrink-0 px-2.5 py-0.5 rounded-full text-[11px] font-semibold text-white/70 hover:text-white bg-white/[0.06] hover:bg-white/[0.12] transition-colors cursor-pointer"
      >
        {t('hostStatus.banner.details')}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => useHostStatusStore.getState().dismissBanner()}
        className="shrink-0 p-1 rounded-full text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-colors cursor-pointer"
      >
        <X size={12} />
      </button>
    </div>
  );
});
