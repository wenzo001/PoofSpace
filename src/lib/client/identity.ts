import { useCallback, useEffect, useState } from 'react';
import { generateNickname, normalizeNickname } from '../nicknames';
import { LIMITS } from '../constants';
import { loadPrefs, rollNick, setNick } from './prefs';

export const LIMITS_NICK = LIMITS.nickChars;

export { generateNickname, normalizeNickname };

export interface NickState {
  nick: string;
  custom: boolean;
  apply: (raw: string) => string;
  roll: () => string;
}

/** Device-cached nickname: generated on first visit and reused until customised. */
export function useNick(): NickState {
  // The nickname lives in localStorage, so the server cannot know it. Reading it during
  // render made the server's random name disagree with the browser's cached one, and React
  // tore the tree down over that text mismatch (#418) - which left the home page rendered
  // but without any handlers. Device identity therefore arrives after mount.
  const [state, setState] = useState<{ nick: string; custom: boolean }>({ nick: '', custom: false });

  useEffect(() => {
    const p = loadPrefs();
    setState({ nick: p.nick, custom: p.nickCustom });
  }, []);

  const apply = useCallback((raw: string) => {
    const next = setNick(raw);
    setState({ nick: next.nick, custom: next.nickCustom });
    return next.nick;
  }, []);

  const roll = useCallback(() => {
    const next = rollNick();
    setState({ nick: next.nick, custom: next.nickCustom });
    return next.nick;
  }, []);

  return { nick: state.nick, custom: state.custom, apply, roll };
}
