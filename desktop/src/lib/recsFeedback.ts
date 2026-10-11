import { createContext, useContext } from 'react';
import { api } from './api';

const trackToCluster = new Map<string, string>();
/** Bounded FIFO — cluster hints for the recently seen tracks only. */
const TRACK_CLUSTER_CAP = 4000;

export function setUrnCluster(urn: string, cluster: string): void {
  if (trackToCluster.size >= TRACK_CLUSTER_CAP && !trackToCluster.has(urn)) {
    const oldest = trackToCluster.keys().next().value;
    if (oldest !== undefined) trackToCluster.delete(oldest);
  }
  trackToCluster.set(urn, cluster);
}

export function getUrnCluster(urn: string): string | undefined {
  return trackToCluster.get(urn);
}

export function recordClusterFeedback(cluster: string, type: 'click' | 'complete'): void {
  if (!cluster) return;
  api('/recommendations/feedback', {
    method: 'POST',
    body: JSON.stringify({ clusterId: cluster, type }),
  }).catch(() => {});
}

interface ClusterFeedbackCtx {
  clusterId: string;
}

const ClusterFeedbackContext = createContext<ClusterFeedbackCtx | null>(null);

export const ClusterFeedbackProvider = ClusterFeedbackContext.Provider;

export function useClusterFeedback(): string | null {
  const ctx = useContext(ClusterFeedbackContext);
  return ctx?.clusterId ?? null;
}
