import { generateNickname, normalizeNickname } from '../nicknames';

const KEY = 'poofspace.prefs.v1';

export interface Prefs {
  nick: string;
  nickCustom: boolean;
  notifyOptIn: boolean;
}

const DEFAULTS: Prefs = { nick: '', nickCustom: false, notifyOptIn: false };

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): Prefs | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    if (typeof parsed.nick !== 'string' || !parsed.nick) return null;
    return {
      nick: normalizeNickname(parsed.nick),
      nickCustom: parsed.nickCustom === true,
      notifyOptIn: parsed.notifyOptIn === true
    };
  } catch {
    return null;
  }
}

function write(p: Prefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(p));
  } catch {
    /* quota or private mode: the session keeps working from memory */
  }
}

let memory: Prefs | null = null;

// A display name is not key material. When the browser offers no CSPRNG the page still has
// to render, and creating a room stays blocked by the crypto assertions in RoomClient.
function nicknameOr(fallback: string): string {
  try {
    return generateNickname();
  } catch {
    return fallback;
  }
}

/** normalizeNickname('') rolls a new name, which is the call that needs a CSPRNG. */
function normalizeOr(raw: string, fallback: string): string {
  try {
    return normalizeNickname(raw);
  } catch {
    return nicknameOr(fallback);
  }
}

/**
 * Device nickname: nothing is written until the reader confirms one. Silently minting and caching a
 * name on first read meant every room had a participant the reader never chose, and the name could
 * not be told apart from a typed one later.
 */
export function loadPrefs(): Prefs {
  if (memory) return memory;
  const stored = read();
  memory = stored ?? { ...DEFAULTS };
  return memory;
}

/** A suggestion to confirm. Called from click/first-paint-after-mount paths only, never during render. */
export function suggestNickname(): string {
  return nicknameOr('访客');
}

export function currentNick(): string {
  return loadPrefs().nick;
}

export function setNick(raw: string): Prefs {
  const current = loadPrefs();
  const nick = normalizeOr(raw, current.nick);
  const next: Prefs = { ...current, nick, nickCustom: nick.length > 0 };
  memory = next;
  write(next);
  return next;
}

export function rollNick(): Prefs {
  const current = loadPrefs();
  const next: Prefs = { ...current, nick: nicknameOr(current.nick), nickCustom: false };
  memory = next;
  write(next);
  return next;
}

export function setNotifyOptIn(on: boolean): void {
  const next: Prefs = { ...loadPrefs(), notifyOptIn: on };
  memory = next;
  write(next);
}
