import React, { useState } from 'react';

/**
 * Artwork `<img>` with a raw-URL retry: the in-app proxy can miss (dead shard,
 * missing size variant, transient failure) while the raw CDN URL still works.
 * Renders `placeholder` when both fail. Pass `key={src}` at the call site so a
 * new track starts over at the proxied URL.
 */
export const ArtworkImg = React.memo(function ArtworkImg({
  src,
  fallback,
  alt = '',
  className,
  placeholder,
}: {
  src: string;
  fallback?: string | null;
  alt?: string;
  className?: string;
  placeholder: React.ReactNode;
}) {
  // 0 = src, 1 = raw fallback, 2 = placeholder
  const [stage, setStage] = useState(0);
  if (stage === 2) return <>{placeholder}</>;
  const active = stage === 1 && fallback ? fallback : src;
  return (
    <img
      src={active}
      alt={alt}
      className={className}
      onError={() => setStage((s) => (s === 0 && fallback && fallback !== src ? 1 : 2))}
    />
  );
});
