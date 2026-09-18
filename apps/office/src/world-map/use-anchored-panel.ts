import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { placeSelectionPanel } from '../rendering/selection-anchor.js';
import type { SelectionTarget } from '../rendering/selection-anchor.js';

/** DOM measurement belongs to the HUD; camera and selected bounds belong to the scene. */
export interface PanelObstacles {
  above: RefObject<HTMLDivElement | null>;
  below: RefObject<HTMLDivElement | null>;
}

export function useAnchoredPanel<T extends HTMLElement>(
  target?: SelectionTarget,
  obstacles?: PanelObstacles
) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [clearance, setClearance] = useState<{ top: number; bottom: number }>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((previous) =>
        previous?.width === width && previous?.height === height ? previous : { width, height }
      );
      const above = obstacles?.above.current;
      const below = obstacles?.below.current;
      const origin = element.offsetParent?.getBoundingClientRect();
      if (above && below && origin) {
        const next = {
          top: above.getBoundingClientRect().bottom - origin.top + 12,
          bottom: below.getBoundingClientRect().top - origin.top - 12,
        };
        setClearance((previous) =>
          previous?.top === next.top && previous?.bottom === next.bottom ? previous : next
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (obstacles?.above.current) observer.observe(obstacles.above.current);
    if (obstacles?.above.current?.parentElement)
      observer.observe(obstacles.above.current.parentElement);
    if (obstacles?.below.current) observer.observe(obstacles.below.current);
    if (element.offsetParent) observer.observe(element.offsetParent);
    return () => observer.disconnect();
  }, [obstacles]);
  const position = target && size ? placeSelectionPanel(target, size, clearance) : undefined;
  return {
    ref,
    style: position
      ? { left: position.x, top: position.y, maxHeight: position.maxHeight }
      : undefined,
  };
}
