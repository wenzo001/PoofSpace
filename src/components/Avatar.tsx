'use client';

import { avatarChar } from '@/lib/nicknames';

const BUCKETS = 8;

/** Deterministic per nickname, and every colour comes from a token class instead of a literal. */
export function avatarIndex(nick: string): number {
  let h = 0;
  for (const ch of nick) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % BUCKETS) + 1;
}

export default function Avatar({ nick, small }: { nick: string; small?: boolean }) {
  const index = avatarIndex(nick || '?');
  return (
    <span
      className={small ? `av av-sm av-${index}` : `av av-${index}`}
      aria-hidden="true"
    >
      {avatarChar(nick)}
    </span>
  );
}
