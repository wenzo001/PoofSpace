'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

function useBodyHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHost(document.body);
  }, []);
  return host;
}

/**
 * Full-screen furniture has to leave the message list. Rows carry
 * `transform: translateY(...)` from the virtual list, and a transformed ancestor captures
 * `position: fixed` AND confines `z-index` to its own stacking context — so an overlay rendered
 * in place scrolls away with the list and loses to `.composer` / `.room-head` no matter what
 * number its `z-index` says. Pre-rendering returns nothing: an overlay only ever exists after a
 * client-side interaction.
 */
export default function Modal({
  title,
  onClose,
  children,
  wide
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const host = useBodyHost();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    // Focus lands only once the portal has actually mounted. `onClose` is deliberately not a
    // dependency: callers pass an inline arrow, so depending on it re-ran this effect on every
    // render and yanked focus back into the dialog — which stole typing from anywhere else on the
    // page while a dialog was open.
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [host]);

  const tree = (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? 'modal modal-wide' : 'modal'}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );

  return host ? createPortal(tree, host) : null;
}
