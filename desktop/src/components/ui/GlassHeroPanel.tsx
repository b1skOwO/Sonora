import type React from 'react';
import { memo } from 'react';
import type { Aura } from '../../lib/aura';
import { usePerfMode } from '../../lib/perf';

interface GlassHeroPanelProps {
  aura: Aura;
  className?: string;
  children: React.ReactNode;
}

function GlassHeroPanelImpl({ className, children }: GlassHeroPanelProps) {
  const perf = usePerfMode();
  const b = perf.blur(40);
  const filter = b > 0 ? `blur(${b}px) saturate(160%)` : undefined;
  return (
    <div
      className={`relative rounded-[2.5rem] ${className ?? ''}`}
      style={{
        background:
          b > 0
            ? 'linear-gradient(165deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.04) 100%)'
            : 'rgba(20,20,24,0.82)',
        backdropFilter: filter,
        WebkitBackdropFilter: filter,
        boxShadow:
          '0 30px 80px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.08)',
        animation: 'hub-rise 700ms cubic-bezier(0.2,0.8,0.2,1) both',
        isolation: 'isolate',
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-px pointer-events-none"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
        }}
      />

      {children}
    </div>
  );
}

export const GlassHeroPanel = memo(GlassHeroPanelImpl);
