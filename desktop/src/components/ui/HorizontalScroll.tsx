import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

interface HorizontalScrollProps {
  children: ReactNode;
  className?: string;
}

const DRAG_THRESHOLD = 6;
const EDGE_FADE_PX = 28;

export function HorizontalScroll({ children, className = '' }: HorizontalScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const dragStateRef = useRef({
    active: false,
    dragging: false,
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
  });

  useEffect(() => {
    return () => {
      document.body.style.removeProperty('user-select');
    };
  }, []);

  // Only fade an edge that actually hides content; a rail that fits stays untouched.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEdges((prev) => {
        const left = el.scrollLeft > 1;
        const right = max > 1 && el.scrollLeft < max - 1;
        return prev.left === left && prev.right === right ? prev : { left, right };
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const maskImage =
    !edges.left && !edges.right
      ? undefined
      : edges.left && edges.right
        ? `linear-gradient(90deg, transparent 0, #000 ${EDGE_FADE_PX}px, #000 calc(100% - ${EDGE_FADE_PX}px), transparent 100%)`
        : edges.left
          ? `linear-gradient(90deg, transparent 0, #000 ${EDGE_FADE_PX}px)`
          : `linear-gradient(90deg, #000 calc(100% - ${EDGE_FADE_PX}px), transparent 100%)`;

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = ref.current;
    if (!el) return;

    dragStateRef.current = {
      active: true,
      dragging: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startScrollLeft: el.scrollLeft,
    };
    document.body.style.userSelect = 'none';
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    const drag = dragStateRef.current;
    if (!el || !drag.active || drag.pointerId !== e.pointerId) return;

    const deltaX = e.clientX - drag.startX;
    if (!drag.dragging && Math.abs(deltaX) > DRAG_THRESHOLD) {
      drag.dragging = true;
      el.setPointerCapture(drag.pointerId);
    }

    if (!drag.dragging) return;
    el.scrollLeft = drag.startScrollLeft - deltaX;
    e.preventDefault();
  };

  const stopDragging = (pointerId: number) => {
    const el = ref.current;
    const drag = dragStateRef.current;
    if (!drag.active || drag.pointerId !== pointerId) return;

    if (el?.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);

    drag.active = false;
    window.setTimeout(() => {
      drag.dragging = false;
    }, 0);
    document.body.style.removeProperty('user-select');
  };

  return (
    <div
      ref={ref}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => stopDragging(e.pointerId)}
      onPointerCancel={(e) => stopDragging(e.pointerId)}
      onClickCapture={(e) => {
        if (dragStateRef.current.dragging) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      className={`flex gap-4 overflow-x-hidden pb-2 scrollbar-hide cursor-grab active:cursor-grabbing ${className}`}
      style={{
        contain: 'layout paint style',
        touchAction: 'pan-y',
        maskImage,
        WebkitMaskImage: maskImage,
      }}
    >
      {children}
    </div>
  );
}
