'use client';

import { useEffect, useRef, useState } from 'react';
import ImagePreview, { type PreviewSlide } from '@/components/ImagePreview';
import type { RoomClient } from '@/lib/client/roomclient';
import { DecryptError, type AttachmentMeta } from '@/lib/crypto/envelope';
import { cachedThumb, dropFull, fullUrl, release, retain } from '@/lib/client/media';

/** Slides decrypted on each side of the one being looked at. More than one is a guess about where
 *  the reader is going; less than one makes every page turn wait. */
const WINDOW = 1;

interface Props {
  client: RoomClient;
  /** Attachment ids of every image message, in the order the reader sees them. */
  ids: string[];
  index: number;
  metaOf: (id: string) => AttachmentMeta | undefined;
  onAuthFail: () => void;
  onClose: () => void;
}

/**
 * Owns the decrypted image: which ones are in memory, and when the viewer is allowed to exist.
 *
 * The row it was opened from cannot own this -- the reader pages away from it, and a viewer mounted
 * inside a list row is the bug this whole file replaced (the same reason the long-message dialog
 * moved out of the row). So the room asks for `{ids, index}`, this holds one `retain` per image it
 * decrypts, and closing drops every one of them.
 */
export default function PreviewHost({ client, ids, index, metaOf, onAuthFail, onClose }: Props) {
  const [changed, setChanged] = useState<number[]>([]);
  const [ready, setReady] = useState(false);
  const slides = useRef<PreviewSlide[]>([]);
  const held = useRef<Set<string>>(new Set());
  const decrypt = useRef<(i: number) => void>(() => {});
  const alive = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    alive.current = true;
    const list = ids.map((id) => {
      const meta = metaOf(id);
      return { src: cachedThumb(id) ?? '', width: meta?.width, height: meta?.height };
    });
    slides.current = list;

    const load = (i: number) => {
      const slide = list[i];
      const id = ids[i];
      const meta = id ? metaOf(id) : undefined;
      if (!slide || !id || !meta || held.current.has(id)) return;
      held.current.add(id);
      // fullUrl revokes what it just decrypted if nobody holds the attachment, so the viewer has
      // to declare itself before the download starts -- the row may well have scrolled away.
      retain(id);
      fullUrl(client, id, meta)
        .then((url) => {
          if (!alive.current) return;
          if (!url) {
            if (i === index) close.current();
            return;
          }
          slide.src = url;
          // The opened slide is written before the viewer exists, so it never needs a refresh;
          // naming it would only rebuild the slide the opening animation is drawing.
          if (i === index) setReady(true);
          else setChanged([i]);
        })
        .catch((err: unknown) => {
          if (err instanceof DecryptError) onAuthFail();
        });
    };
    decrypt.current = load;
    load(index);
    for (let i = index - WINDOW; i <= index + WINDOW; i++) {
      if (i >= 0 && i < ids.length && i !== index) load(i);
    }

    return () => {
      alive.current = false;
      held.current.forEach((id) => {
        dropFull(id);
        release(id);
      });
      held.current.clear();
    };
    // Mount-only: `ids` is the list captured when the reader clicked, and re-running this would
    // re-decrypt everything the viewer already holds.
  }, []);

  return ready ? (
    <ImagePreview
      slides={slides.current}
      index={index}
      changed={changed}
      onIndexChange={(i) => {
        for (let j = i - WINDOW; j <= i + WINDOW; j++) {
          if (j >= 0 && j < ids.length) decrypt.current(j);
        }
      }}
      onClose={() => close.current()}
    />
  ) : null;
}
