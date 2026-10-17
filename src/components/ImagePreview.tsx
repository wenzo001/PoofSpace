'use client';

import { useEffect, useRef } from 'react';
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import 'photoswipe/style.css';
import type { PhotoSwipeOptions } from 'photoswipe';

export interface PreviewImage {
  src: string;
  width?: number;
  height?: number;
}

/**
 * Everything PhotoSwipe's DOM looks like lives in this file, so the browser legs judge our
 * geometry instead of a third party's class names.
 *
 * appendToEl is a PhotoSwipe option rather than a Lightbox option, but the Lightbox hands its whole
 * options object to the core (`new module(this.options)`), so it reaches the runtime and only needs
 * the intersection to satisfy tsc. It is passed explicitly on purpose: the default is not a
 * guarantee, and a viewer mounted inside a virtual-list row would be captured by that row's
 * transform -- which is the exact stacking-context bug the portal above exists to avoid.
 */
type LightboxOpts = NonNullable<ConstructorParameters<typeof PhotoSwipeLightbox>[0]> &
  Pick<PhotoSwipeOptions, 'appendToEl'>;

export default function ImagePreview({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const closed = useRef(false);

  useEffect(() => {
    const lb = new PhotoSwipeLightbox({
      appendToEl: document.body,
      dataSource: [{ src: image.src, width: image.width, height: image.height, alt: '' }],
      pswpModule: () => import('photoswipe'),
      zoom: true,
      gestures: true,
      keyboard: true,
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
      onClose();
    };
    lb.on('close', handleClose);
    // The legs must not bind to a third party's class names, so the adapter stamps its own hooks
    // onto the nodes it cares about. This is the only place outside this file that may be relied on.
    lb.on('change', () => {
      const p = lb.pswp;
      if (!p?.element) return;
      p.element.dataset.preview = 'viewer';
      const holder = p.currSlide?.holderElement;
      if (holder) holder.dataset.preview = 'image';
    });
    lb.init();
    lb.loadAndOpen(0);

    return () => {
      lb.off('close', handleClose);
      lb.destroy();
    };
  }, [image.src, image.width, image.height, onClose]);

  return null;
}
