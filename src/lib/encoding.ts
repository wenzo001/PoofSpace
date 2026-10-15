export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const pad = norm.length % 4 === 0 ? norm : norm + '='.repeat(4 - (norm.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(s: string): Uint8Array {
  if (!/^[\da-f]*$/i.test(s) || s.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

export function writeUintBE(value: number, width: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error('bad integer');
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  if (v !== 0) throw new Error('value does not fit in ' + width + ' bytes');
  return out;
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

export function randomBytes(byteLength: number): Uint8Array {
  const g = globalThis.crypto as Crypto | undefined;
  if (!g || typeof g.getRandomValues !== 'function') {
    throw new Error('CSPRNG unavailable: crypto.getRandomValues is missing in this context');
  }
  const out = new Uint8Array(byteLength);
  // WebCrypto refuses buffers over 65536 bytes per call.
  for (let off = 0; off < byteLength; off += 65536) {
    g.getRandomValues(out.subarray(off, Math.min(off + 65536, byteLength)));
  }
  return out;
}

export function randomInt(bound: number): number {
  if (bound <= 0) throw new Error('bound must be positive');
  const buf = new Uint32Array(1);
  const g = globalThis.crypto as Crypto | undefined;
  if (!g || typeof g.getRandomValues !== 'function') throw new Error('CSPRNG unavailable');
  const limit = Math.floor(0x100000000 / bound) * bound;
  let x = 0;
  for (;;) {
    g.getRandomValues(buf);
    x = buf[0] as number;
    if (x < limit) return x % bound;
  }
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function groupString(s: string, size: number, sep: string): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join(sep);
}

export function ungrouppString(s: string): string {
  return s.replace(/[\s.\-_:]/g, '');
}
