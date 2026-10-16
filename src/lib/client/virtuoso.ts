'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';

export interface VirtualOptions {
  estimate: number;
  overscanPx?: number;
  bottomThresholdPx?: number;
}

/**
 * The row the reader is looking at, and the two numbers needed to keep it there:
 * `dy` is how far the viewport top sits below that row's own top edge (a row-relative quantity,
 * so it survives every re-measurement), and `at` is the scroll position the hold was taken at,
 * which is what separates "the reader moved" from "the content moved underneath them".
 */
export interface Anchor {
  key: string;
  dy: number;
  at: number;
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
  // Rows above the viewport mount at the estimate and are measured a frame later, and a page of
  // older history lands as thousands of pixels added overhead. Without holding the row the reader
  // is looking at, every one of those changes pushes the list down under them - which reads as
  // "scrolling up bounces the canvas back down" and makes upward scrolling fight the finger.
  const viewAnchorRef = useRef<Anchor | null>(null);
  const offsetsRef = useRef<number[]>([]);
  const keysRef = useRef<readonly string[]>([]);
  const [nearBottom, setNearBottom] = useState(true);

  const anchorAt = (top: number): Anchor | null => {
    const ks = keysRef.current;
    const offs = offsetsRef.current;
    if (ks.length === 0) return null;
    let index = ks.length - 1;
    for (let i = 0; i < ks.length; i++) {
      if ((offs[i + 1] ?? 0) > top) {
        index = i;
        break;
      }
    }
    const key = ks[index];
    return key ? { key, dy: top - (offs[index] ?? 0), at: top } : null;
  };

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
      // The reader moved, so the row they landed on becomes the reference point. Capturing it here
      // (rather than in the layout pass) is what keeps the correction from fighting a real scroll:
      // by the time heights change underneath it, `want` equals where the reader put the page.
      viewAnchorRef.current = atBottom ? null : anchorAt(el.scrollTop);
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
    // Read where the reader actually is, not where React's state said a frame ago. The gesture and
    // the history fetch land in the same tick, so a lagged scrollTop becomes an offset error, and
    // the restore then puts the page exactly one wheel-step away from where the reader left it.
    anchorRef.current = anchorAt(node.scrollTop);
  }, [keys]);

  /**
   * Called after a page of history was prepended: the hold taken before the fetch becomes the live
   * one, so the row the reader was on is the row the layout pass puts back in place.
   */
  const onContentGrowth = useCallback(() => {
    const a = anchorRef.current;
    anchorRef.current = null;
    if (a && keys.indexOf(a.key) >= 0) viewAnchorRef.current = a;
  }, [keys]);

  useLayoutEffect(() => {
    offsetsRef.current = offsets as number[];
    keysRef.current = keys;
  });

  useLayoutEffect(() => {
    const node = elRef.current;
    if (!node) return;
    if (pinnedRef.current) {
      if (keys.length > 0) node.scrollTop = node.scrollHeight;
      viewAnchorRef.current = null;
      return;
    }
    const a = viewAnchorRef.current;
    const index = a ? keys.indexOf(a.key) : -1;
    if (!a || index < 0) {
      viewAnchorRef.current = anchorAt(node.scrollTop);
      return;
    }
    // The reader's own movement since the hold was taken is added back, so this pass compensates
    // content that shifted under them without cancelling a gesture that landed first: a row whose
    // measurement arrived late, a page of older history, and a wheel turn are three different
    // things, and only the first two are the list's to correct.
    const want = (offsets[index] ?? 0) + a.dy + (node.scrollTop - a.at);
    if (Math.abs(node.scrollTop - want) >= 1) node.scrollTop = want;
    viewAnchorRef.current = { key: a.key, dy: a.dy, at: node.scrollTop };
    setScrollTop(node.scrollTop);
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
