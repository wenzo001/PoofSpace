'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';

export interface VirtualOptions {
  estimate: number;
  overscanPx?: number;
  bottomThresholdPx?: number;
}

export interface Anchor {
  key: string;
  offset: number;
}

export interface VirtualList {
  setScrollElement: (el: HTMLDivElement | null) => void;
  start: number;
  end: number;
  totalHeight: number;
  offsetOf: (index: number) => number;
  measure: (key: string) => (el: HTMLElement | null) => void;
  nearBottom: boolean;
  pinned: boolean;
  scrollToBottom: () => void;
  captureAnchor: () => void;
  onContentGrowth: () => void;
}

/**
 * Windowed list with real row measurement. Rows are absolutely positioned inside a
 * sizer, keyed by stable clientMsgId, so scrolling history never re-renders the world.
 */
export function useVirtualList(keys: readonly string[], opts: VirtualOptions): VirtualList {
  const overscan = opts.overscanPx ?? 400;
  const bottomThreshold = opts.bottomThresholdPx ?? 120;

  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const elRef = useRef<HTMLDivElement | null>(null);
  const observed = useRef(new WeakMap<Element, string>());
  const elementByKey = useRef(new Map<string, Element>());
  const roRef = useRef<ResizeObserver | null>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const restoreRef = useRef<{ key: string; offset: number } | null>(null);
  const [nearBottom, setNearBottom] = useState(true);

  const setScrollElement = useCallback((next: HTMLDivElement | null) => {
    elRef.current = next;
    setEl(next);
  }, []);

  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance <= bottomThreshold;
      pinnedRef.current = atBottom;
      setNearBottom(atBottom);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [el, bottomThreshold]);

  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      // Functional update on purpose: this observer is created once, so reading the `heights`
      // binding here would hand back the first render's map, and every callback would then
      // overwrite all other rows' measurements - each wiped row drops to the estimate and the
      // pinned bottom jumps by that difference on the next frame.
      setHeights((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const entry of entries) {
          const key = observed.current.get(entry.target);
          if (!key) continue;
          // Same basis as the ref-measure callback: two writers using different box models would
          // disagree by a few pixels on every row, forever.
          const h = Math.round(entry.target.getBoundingClientRect().height);
          if (h > 0 && Math.abs((next.get(key) ?? 0) - h) >= 1) {
            next.set(key, h);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    roRef.current = ro;
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, []);

  const measure = useCallback(
    (key: string) => (node: HTMLElement | null) => {
      if (!node) {
        // A row that scrolled out of the window must stop being observed, otherwise a
        // long session accumulates ResizeObserver targets for every row ever rendered.
        const prev = elementByKey.current.get(key);
        if (prev) {
          roRef.current?.unobserve(prev);
          elementByKey.current.delete(key);
          observed.current.delete(prev);
        }
        return;
      }
      elementByKey.current.set(key, node);
      observed.current.set(node, key);
      roRef.current?.observe(node);
      const h = Math.round(node.getBoundingClientRect().height);
      if (h > 0 && Math.abs((heights.get(key) ?? 0) - h) >= 1) {
        const next = new Map(heights);
        next.set(key, h);
        setHeights(next);
      }
    },
    [heights]
  );

  const offsets = useMemo(() => {
    const out: number[] = new Array<number>(keys.length + 1);
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
      out[i] = acc;
      acc += heights.get(keys[i] as string) ?? opts.estimate;
    }
    out[keys.length] = acc;
    return out;
  }, [keys, heights, opts.estimate]);

  const totalHeight = offsets[offsets.length - 1] ?? 0;

  const { start, end } = useMemo(() => {
    if (keys.length === 0) return { start: 0, end: 0 };
    const top = Math.max(0, scrollTop - overscan);
    const bottom = scrollTop + (viewport || 0) + overscan;
    let s = 0;
    let e = keys.length;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid] ?? 0) + opts.estimate < top) lo = mid + 1;
      else hi = mid;
    }
    s = lo;
    lo = s;
    hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid] ?? 0) < bottom) lo = mid + 1;
      else hi = mid;
    }
    e = Math.min(keys.length, lo + 1);
    return { start: s, end: e };
  }, [offsets, keys.length, scrollTop, viewport, overscan, opts.estimate]);

  const offsetOf = useCallback((index: number) => offsets[index] ?? 0, [offsets]);

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true;
    setNearBottom(true);
    const node = elRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  const captureAnchor = useCallback(() => {
    const node = elRef.current;
    if (!node || keys.length === 0) return;
    const top = scrollTop;
    let index = 0;
    for (let i = 0; i < keys.length; i++) {
      if ((offsets[i + 1] ?? 0) > top) {
        index = i;
        break;
      }
      index = i;
    }
    anchorRef.current = { key: keys[index] as string, offset: top - (offsets[index] ?? 0) };
  }, [keys, offsets, scrollTop]);

  /** Called after a page of history was prepended: the anchor row is put back in place. */
  const onContentGrowth = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    const index = keys.indexOf(a.key);
    if (index < 0) {
      anchorRef.current = null;
      return;
    }
    restoreRef.current = { key: a.key, offset: a.offset };
    anchorRef.current = null;
  }, [keys]);

  useLayoutEffect(() => {
    const node = elRef.current;
    if (!node) return;
    const restore = restoreRef.current;
    if (restore) {
      const index = keys.indexOf(restore.key);
      if (index >= 0) {
        node.scrollTop = (offsets[index] ?? 0) + restore.offset;
        setScrollTop(node.scrollTop);
      }
      restoreRef.current = null;
      return;
    }
    if (pinnedRef.current && keys.length > 0) {
      node.scrollTop = node.scrollHeight;
    }
  }, [offsets, totalHeight, keys, start, end]);

  useEffect(() => {
    if (viewport === 0 && el) setViewport(el.clientHeight);
  }, [el, viewport]);

  return {
    setScrollElement,
    start,
    end,
    totalHeight,
    offsetOf,
    measure,
    nearBottom,
    pinned: pinnedRef.current,
    scrollToBottom,
    captureAnchor,
    onContentGrowth
  };
}

/** Force a re-render when React needs fresh measurement-driven layout. */
export function useInvalidator(): () => void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return bump;
}
