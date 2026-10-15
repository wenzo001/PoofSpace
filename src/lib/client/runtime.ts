import { RoomClient, type RoomClientOptions, type WsLike } from './roomclient';
import {
  buildInviteLink,
  decodeRoomId,
  decodeSecret,
  encodeRoomId,
  makeInviteCode,
  parseInviteInput,
  type InviteParts
} from '../crypto/invite';

export interface RuntimeLimits {
  historyPageSize: number;
  chunkBytes: number;
  chunkBytesMax: number;
  attachmentBytesMax: number;
  textPlaintextBytes: number;
  uploadConcurrencyMax: number;
  msgPerSecond: number;
  roomIdleTtlMs: number;
}

export interface RuntimeConfig {
  proto: number;
  maxMembersDefault: number;
  limits: RuntimeLimits;
  publicBaseUrl: string | null;
}

let cached: RuntimeConfig | null = null;

export async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  if (cached) return cached;
  try {
    const r = await fetch('/api/runtime-config', { cache: 'no-store' });
    if (!r.ok) return null;
    const body = (await r.json()) as RuntimeConfig;
    cached = body;
    return body;
  } catch {
    return null;
  }
}

/** No hardcoded origin: the public base comes from the server, else from location. */
export function publicOrigin(cfg: RuntimeConfig | null): string {
  const base = cfg?.publicBaseUrl;
  if (base) {
    try {
      const u = new URL(base);
      if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through to location */
    }
  }
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

function openSocket(url: string): WsLike {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const shim: WsLike = {
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closing */
      }
    },
    get readyState() {
      return ws.readyState;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
  };
  ws.addEventListener('open', () => shim.onopen?.());
  ws.addEventListener('message', (ev) => shim.onmessage?.({ data: ev.data }));
  ws.addEventListener('close', () => shim.onclose?.());
  ws.addEventListener('error', () => shim.onerror?.());
  return shim;
}

export function clientOptions(): RoomClientOptions {
  return { base: window.location.origin, openSocket };
}

export type { InviteParts };

/** RoomClient wipes the secret it was handed, so credentials are read back from the invite. */
export function credentialsFromClient(client: RoomClient): InviteParts | null {
  return parseInviteInput(client.publicInvite.link);
}

export function secretFromFragment(fragment: string): Uint8Array | null {
  try {
    return decodeSecret(fragment);
  } catch {
    return null;
  }
}

export function canonicalRoomId(roomId: string): string | null {
  try {
    return encodeRoomId(decodeRoomId(roomId));
  } catch {
    return null;
  }
}

export interface InviteDisplay {
  roomId: string;
  link: string;
  code: string;
}

export function inviteDisplay(parts: InviteParts, origin: string): InviteDisplay {
  return {
    roomId: parts.roomId,
    link: buildInviteLink(origin, parts),
    code: makeInviteCode(parts)
  };
}
