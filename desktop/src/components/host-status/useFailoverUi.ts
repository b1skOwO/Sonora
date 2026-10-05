import { useShallow } from 'zustand/shallow';
import { type FailoverUi, selectFailoverUi, useHostStatusStore } from '../../lib/host-status';
import { useAppStatusStore } from '../../stores/app-status';

/** Derived failover-UI из вердикта main + connectivity-гейтов. */
export function useFailoverUi(): FailoverUi {
  const verdicts = useHostStatusStore(useShallow((s) => ({ main: s.main, net: s.net })));
  const navigatorOnline = useAppStatusStore((s) => s.navigatorOnline);
  const offlineBypass = useAppStatusStore((s) => s.offlineBypass);
  return selectFailoverUi(verdicts, navigatorOnline, offlineBypass);
}
