import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useLayoutEffect, useRef, useState } from 'react';

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  overscan?: number;
  className?: string;
  disabled?: boolean;
  getItemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}

export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 6,
  className,
  disabled = false,
  getItemKey,
  renderItem,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  // Distance between the top of the scroll element and this list. The
  // virtualizer works in the scroll element's coordinates, so without it the
  // rendered window sits `offset` px below the physically visible rows — a
  // blank gap at the top of the viewport. Measured before paint and kept fresh
  // as the layout above the list shifts (hero art, async shelves, ...).
  const [scrollMargin, setScrollMargin] = useState(0);

  // Resolve the scroll element before paint to avoid a visible 0-row first frame.
  useLayoutEffect(() => {
    setScrollElement((containerRef.current?.closest('main') as HTMLElement | null) ?? null);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const scroll = container?.closest('main') as HTMLElement | null;
    if (!container || !scroll) return;
    const next = Math.round(
      container.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
    );
    setScrollMargin((prev) => (prev === next ? prev : next));
  });

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan,
    scrollMargin,
  });

  if (disabled) {
    return (
      <div ref={containerRef} className={className}>
        {items.map((item, index) => (
          <React.Fragment key={getItemKey(item, index)}>{renderItem(item, index)}</React.Fragment>
        ))}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height: totalHeight, position: 'relative', width: '100%' }}
    >
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        return (
          <div
            key={getItemKey(item, virtualItem.index)}
            data-index={virtualItem.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: virtualItem.size,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            {renderItem(item, virtualItem.index)}
          </div>
        );
      })}
    </div>
  );
}
