const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < B32.length; i++) lookup.set(B32[i] as string, i);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toLowerCase()) {
    const v = lookup.get(ch);
    if (v === undefined) throw new Error('invalid base32 character: ' + ch);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function group(s: string, size: number, sep = '-'): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join(sep);
}

export function ungroup(s: string): string {
  return s.replace(/[\s\-_.]/g, '').toLowerCase();
}
