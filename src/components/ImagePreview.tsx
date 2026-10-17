'use client';

import { useEffect, useRef } from 'react';
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import type { PhotoSwipeOptions } from 'photoswipe';

export interface PreviewSlide {
  /**
   * Replaced in place by the owner when the full image finishes decrypting: the library reads this
   * same object, so an upgrade does not need a new array -- only the index it happened at, which is
   * what `changed` carries.
   */
  src: string;
  width?: number;
  height?: number;
}

interface Props {
  slides: PreviewSlide[];
  index: number;
  changed: number[];
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * `appendToEl`, `arrowKeys` and `preload` are PhotoSwipe options rather than Lightbox options, but
 * the Lightbox hands its whole options object to the core (`new module(this.options)`), so they
 * reach the runtime and only need the intersection to satisfy tsc.
 *
 * `appendToEl` is passed explicitly even though the library's own default is `document.body`
 * (`photoswipe.esm.js:7034`) -- which means the leg that checks the parent element cannot go red
 * when this option is removed, and the report says so instead of claiming a witness it does not
 * have. What keeps the viewer out of the list row is that this component renders `null` and the
 * library appends its own container; the option is the statement of intent, not the mechanism.
 */
type LightboxOpts = NonNullable<ConstructorParameters<typeof PhotoSwipeLightbox>[0]> &
  Pick<PhotoSwipeOptions, 'appendToEl' | 'arrowKeys' | 'preload'>;

export default function ImagePreview({ slides, index, changed, onIndexChange, onClose }: Props) {
  const lbRef = useRef<PhotoSwipeLightbox | null>(null);
  const closed = useRef(false);
  const seen = useRef(-1);
  const handlers = useRef({ onIndexChange, onClose });
  handlers.current = { onIndexChange, onClose };

  useEffect(() => {
    const lb = new PhotoSwipeLightbox({
      appendToEl: document.body,
      dataSource: slides,
      pswpModule: () => import('photoswipe'),
      // Decryption is what takes time here, not rendering. PhotoSwipe's own preload builds the
      // neighbouring slides' elements straight after opening, and a slide built before its image
      // is decrypted would be torn down and re-built a moment later -- which throws away whatever
      // the reader is looking at. The owner decrypts the window around the current index and names
      // the index it upgraded, so a refresh only ever happens where the pixels actually changed.
      preload: [0, 0],
      zoom: true,
      gestures: true,
      keyboard: true,
      arrowKeys: true,
      wheelToZoom: true,
      doubleTapAction: 'zoom',
      maxZoomLevel: 4,
      bgOpacity: 0.92,
      showHideAnimationType: 'zoom',
      clickToCloseNonZoomable: true
    } as LightboxOpts);

    const handleClose = () => {
      if (closed.current) return;
      closed.current = true;
      handlers.current.onClose();
    };
    // The legs must not bind to a third party's class names, so the adapter stamps its own hooks
    // onto the nodes it cares about. Nothing outside this file may rely on them.
    const onChange = () => {
      const p = lb.pswp;
      if (!p?.element) return;
      p.element.dataset.preview = 'viewer';
      const holder = p.currSlide?.holderElement;
      // Exactly one node may carry the image hook. The library rotates three reused holders between
      // indexes, so a stamp left on the slide the reader came from stays the first node a
      // [data-preview="image"] query finds -- and a page turn would read as "nothing changed".
      for (const el of Array.from(p.element.querySelectorAll('[data-preview="image"]'))) {
        if (el !== holder) el.removeAttribute('data-preview');
      }
      if (holder) holder.dataset.preview = 'image';
      if (p.currIndex !== seen.current) {
        seen.current = p.currIndex;
        handlers.current.onIndexChange(p.currIndex);
      }
    };
    lb.on('close', handleClose);
    lb.on('change', onChange);
    lb.init();
    lb.loadAndOpen(Math.max(0, Math.min(index, slides.length - 1)));
    lbRef.current = lb;

    return () => {
      lbRef.current = null;
      lb.off('close', handleClose);
      lb.destroy();
    };
    // Mount-only on purpose: `slides` is mutated in place and `index` is the slide to open with.
    // Re-running this would destroy the viewer the reader is looking at and reset their zoom.
  }, []);

  useEffect(() => {
    const p = lbRef.current?.pswp;
    if (!p || changed.length === 0) return;
    for (const i of changed) {
      // The library reads `src` when it builds the slide's element, so an image that finished
      // decrypting only reaches the screen through its documented per-index refresh. A holder that
      // does not currently contain this index is left alone by the call.
      p.refreshSlideContent(i);
    }
  }, [changed]);

  return null;
}
