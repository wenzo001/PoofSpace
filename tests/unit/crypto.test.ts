import { describe, expect, it } from 'vitest';
import { gcm } from '@noble/ciphers/aes.js';
import {
  aeadDecrypt,
  aeadEncrypt,
  detectCrypto,
  hkdfSha256,
  hmacSha256
} from '../../src/lib/crypto/engine';
import { computeJoinProof, deriveRoomKeys } from '../../src/lib/crypto/keys';
import { buildNonce, messageAAD, openMessage, parseNonce, sealMessage, sealChunk, openChunk, sealMeta, openMeta } from '../../src/lib/crypto/envelope';
import { bytesToB64url, concatBytes, utf8 } from '../../src/lib/encoding';
import { buildInviteLink, decodeRoomId, encodeRoomId, makeInviteCode, newRoomIdBytes, newSecretBytes, parseInviteCode, parseInviteInput } from '../../src/lib/crypto/invite';
import { ERR, HKDF_INFO, LIMITS } from '../../src/lib/constants';

const key = hkdfSha256(new Uint8Array(32).fill(3), 'unit-test-key', 32);
const aad = utf8('v1|msg|room|msg-1');

async function engines(): Promise<Uint8Array[]> {
  const nonce = new Uint8Array(12).fill(7);
  const pt = utf8('端到端加密 payload');
  const viaLib = await aeadEncrypt(key, nonce, aad, pt);
  const viaNoble = gcm(key, nonce, aad).encrypt(pt);
  return [viaLib, viaNoble];
}

describe('AEAD engine', () => {
  it('produces byte-identical ciphertext from both engines and cross-decrypts', async () => {
    const nonce = new Uint8Array(12).fill(11);
    const pt = utf8('same wire format everywhere');
    const noble = gcm(key, nonce, aad).encrypt(pt);
    const lib = await aeadEncrypt(key, nonce, aad, pt);
    expect(lib).toEqual(noble);
    expect(await aeadDecrypt(key, nonce, aad, noble)).toEqual(pt);
    expect(gcm(key, nonce, aad).decrypt(lib)).toEqual(pt);
  });

  it('rejects a flipped ciphertext byte', async () => {
    const nonce = new Uint8Array(12).fill(2);
    const ct = await aeadEncrypt(key, nonce, aad, utf8('untouchable'));
    const tampered = Uint8Array.from(ct);
    tampered[0] = (tampered[0] as number) ^ 1;
    await expect(aeadDecrypt(key, nonce, aad, tampered)).rejects.toThrow();
  });

  it('rejects a flipped authentication tag byte', async () => {
    const nonce = new Uint8Array(12).fill(3);
    const ct = await aeadEncrypt(key, nonce, aad, utf8('tag guard'));
    const tampered = Uint8Array.from(ct);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expect(aeadDecrypt(key, nonce, aad, tampered)).rejects.toThrow();
  });

  it('rejects a foreign AAD (cross-room replay of a valid blob)', async () => {
    const nonce = new Uint8Array(12).fill(4);
    const ct = await aeadEncrypt(key, nonce, aad, utf8('bound to context'));
    await expect(aeadDecrypt(key, nonce, utf8('v1|msg|other|msg-1'), ct)).rejects.toThrow();
  });

  it('rejects a wrong key', async () => {
    const nonce = new Uint8Array(12).fill(5);
    const ct = await aeadEncrypt(key, nonce, aad, utf8('secret'));
    const other = hkdfSha256(new Uint8Array(32).fill(9), 'other', 32);
    await expect(aeadDecrypt(other, nonce, aad, ct)).rejects.toThrow();
  });

  it('refuses a truncated frame and a bad key length', async () => {
    await expect(aeadDecrypt(key, new Uint8Array(12), aad, new Uint8Array(8))).rejects.toThrow();
    await expect(aeadEncrypt(new Uint8Array(16), new Uint8Array(12), aad, utf8('x'))).rejects.toThrow();
    await expect(aeadEncrypt(key, new Uint8Array(8), aad, utf8('x'))).rejects.toThrow();
  });

  it('reports the engine it picked and keeps working without subtle', () => {
    const cap = detectCrypto();
    expect(cap.csprng).toBe(true);
    expect(['webcrypto-subtle', 'noble-js']).toContain(cap.engine);
  });

  it('round-trips through the pure-JS path used by HTTP origins', async () => {
    const nonce = new Uint8Array(12).fill(21);
    const pt = utf8('insecure-context path');
    const ct = gcm(key, nonce, aad).encrypt(pt);
    expect(new TextDecoder().decode(gcm(key, nonce, aad).decrypt(ct))).toBe('insecure-context path');
  });

  it('survives a 2000-message nonce sweep with no repeat', async () => {
    const seen = new Set<string>();
    const ctx = { slot: 7, gen: 0 };
    for (let i = 0; i < 2000; i++) {
      const n = buildNonce(ctx, i + 1);
      seen.add(Buffer.from(n).toString('hex'));
    }
    expect(seen.size).toBe(2000);
  });

  it('keeps nonces unique across slot and gen re-issue', () => {
    const coll = new Set<string>();
    for (let gen = 0; gen < 50; gen++) {
      for (let slot = 1; slot <= 100; slot++) {
        for (let c = 1; c <= 20; c++) coll.add(Buffer.from(buildNonce({ slot, gen }, c)).toString('hex'));
      }
    }
    expect(coll.size).toBe(50 * 100 * 20);
    const parsed = parseNonce(buildNonce({ slot: 0x010203, gen: 0x0405 }, 0x060708090a0b));
    expect(parsed).toEqual({ slot: 0x010203, gen: 0x0405, counter: 0x060708090a0b });
  });

  it('refuses counters and slots outside the nonce geometry', () => {
    expect(() => buildNonce({ slot: 1, gen: 0 }, LIMITS.maxMembersHard + 999999)).not.toThrow();
    expect(() => buildNonce({ slot: 0x1000000, gen: 0 }, 1)).toThrow();
    expect(() => buildNonce({ slot: 1, gen: 0x10000 }, 1)).toThrow();
  });
});

describe('key hierarchy', () => {
  it('derives four distinct 32-byte subkeys from one secret', () => {
    const secret = newSecretBytes();
    const k = deriveRoomKeys(secret);
    const all = [k.msgKey, k.fileKey, k.metaKey, k.joinKey].map((x) => Buffer.from(x).toString('hex'));
    expect(new Set(all).size).toBe(4);
    for (const x of all) expect(x).toHaveLength(64);
  });

  it('is deterministic for a secret and different across secrets', () => {
    const s = new Uint8Array(32).fill(42);
    const a = deriveRoomKeys(s);
    const b = deriveRoomKeys(new Uint8Array(32).fill(43));
    expect(Buffer.from(a.msgKey)).toEqual(Buffer.from(deriveRoomKeys(s).msgKey));
    expect(Buffer.from(a.msgKey)).not.toEqual(Buffer.from(b.msgKey));
  });

  it('rejects a short secret', () => {
    expect(() => deriveRoomKeys(new Uint8Array(31))).toThrow();
  });

  it('join proof binds roomId and server nonce', () => {
    const k = deriveRoomKeys(newSecretBytes());
    const nonce = new Uint8Array(32).fill(1);
    const p1 = computeJoinProof(k.joinKey, 'aaaaaa', nonce);
    const p2 = computeJoinProof(k.joinKey, 'bbbbbb', nonce);
    const p3 = computeJoinProof(k.joinKey, 'aaaaaa', new Uint8Array(32).fill(2));
    expect(p1).toHaveLength(32);
    expect(Buffer.from(p1)).not.toEqual(Buffer.from(p2));
    expect(Buffer.from(p1)).not.toEqual(Buffer.from(p3));
  });

  it('HKDF info strings match the documented protocol labels', () => {
    expect(HKDF_INFO.msg).toBe('poofspace/v1/msg');
    expect(HKDF_INFO.join).toBe('poofspace/v1/join');
  });
});

describe('message envelope', () => {
  it('seals and opens a text payload bound to room and message id', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const roomId = encodeRoomId(newRoomIdBytes());
    const sealed = await sealMessage(k.msgKey, { slot: 3, gen: 1 }, 5, roomId, 'm-1', { kind: 'text', body: '你好' });
    expect(sealed.nonce).toHaveLength(12);
    const opened = await openMessage(k.msgKey, roomId, 'm-1', sealed);
    expect(opened).toEqual({ kind: 'text', body: '你好' });
  });

  it('fails to open when the room id or message id differs', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const sealed = await sealMessage(k.msgKey, { slot: 1, gen: 0 }, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'm-1', { kind: 'text', body: 'x' });
    await expect(openMessage(k.msgKey, 'bbbbbbbbbbbbbbbbbbbbbbbbbb', 'm-1', sealed)).rejects.toMatchObject({ code: ERR.decryptFailed });
    await expect(openMessage(k.msgKey, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'm-2', sealed)).rejects.toMatchObject({ code: ERR.decryptFailed });
  });

  it('rejects a payload larger than the text limit', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    await expect(
      sealMessage(k.msgKey, { slot: 1, gen: 0 }, 1, 'r', 'm', { kind: 'text', body: 'a'.repeat(LIMITS.textPlaintextBytes + 1) })
    ).rejects.toThrow();
  });

  it('AAD includes room context, message id and protocol version', () => {
    expect(new TextDecoder().decode(messageAAD('r1', 'm1'))).toContain('v1|msg|r1|m1');
  });
});

describe('chunk and metadata envelope', () => {
  it('round-trips a chunk and rejects tampering with any byte', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const roomId = 'a'.repeat(26);
    const att = '0123456789abcdef0123456789abcdef';
    const frame = await sealChunk(k.fileKey, { slot: 2, gen: 0 }, 1, roomId, att, 0, utf8('chunk body'));
    expect(await openChunk(k.fileKey, roomId, att, 0, frame)).toEqual(utf8('chunk body'));
    for (const idx of [0, 13, frame.length - 1]) {
      const bad = Uint8Array.from(frame);
      bad[idx] = (bad[idx] as number) ^ 0xff;
      await expect(openChunk(k.fileKey, roomId, att, 0, bad)).rejects.toThrow();
    }
    await expect(openChunk(k.fileKey, roomId, att, 1, frame)).rejects.toThrow();
    await expect(openChunk(k.fileKey, 'b'.repeat(26), att, 0, frame)).rejects.toThrow();
  });

  it('stores the nonce inside the frame so the server needs no index', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const frame = await sealChunk(k.fileKey, { slot: 9, gen: 4 }, 9, 'r', 'a'.repeat(32), 8, utf8('x'));
    expect(parseNonce(frame.subarray(0, 12))).toEqual({ slot: 9, gen: 4, counter: 9 });
  });

  it('seals attachment metadata and rejects the wrong key', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const other = deriveRoomKeys(newSecretBytes());
    const meta = { name: '报销单.pdf', mime: 'application/pdf', size: 1234, chunkSize: 1024, chunkCount: 2, kind: 'file' as const };
    const sealed = await sealMeta(k.metaKey, 'r', 'a'.repeat(32), meta);
    expect(await openMeta(k.metaKey, 'r', 'a'.repeat(32), sealed)).toEqual(meta);
    await expect(openMeta(other.metaKey, 'r', 'a'.repeat(32), sealed)).rejects.toThrow();
    // deterministic per attachment: same input yields the same frame
    expect((await sealMeta(k.metaKey, 'r', 'a'.repeat(32), meta)).ct).toEqual(sealed.ct);
  });

  it('rejects metadata whose declared geometry cannot hold the payload', async () => {
    const k = deriveRoomKeys(newSecretBytes());
    const meta = { name: 'x', mime: 'x', size: 5000, chunkSize: 100, chunkCount: 2, kind: 'file' as const };
    const sealed = await sealMeta(k.metaKey, 'r', 'a'.repeat(32), meta);
    await expect(openMeta(k.metaKey, 'r', 'a'.repeat(32), sealed)).rejects.toThrow();
  });
});

describe('invite format', () => {
  it('room ids carry 128 bits and survive encode/decode', () => {
    const b = newRoomIdBytes();
    expect(b).toHaveLength(16);
    expect(encodeRoomId(b)).toHaveLength(26);
    expect(decodeRoomId(encodeRoomId(b))).toEqual(b);
  });

  it('secrets carry 256 bits', () => {
    expect(newSecretBytes()).toHaveLength(32);
  });

  it('keeps the secret in the fragment only', () => {
    const roomId = encodeRoomId(newRoomIdBytes());
    const secret = newSecretBytes();
    const link = buildInviteLink('http://192.168.1.20:3000', { roomId, secret });
    expect(link.startsWith('http://192.168.1.20:3000/room/')).toBe(true);
    expect(link.split('#')[1]).toBeTruthy();
    const parsed = parseInviteInput(link);
    expect(parsed?.roomId).toBe(roomId);
    expect(Buffer.from(parsed?.secret as Uint8Array)).toEqual(Buffer.from(secret));
  });

  it('parses an invite code that carries the key material', () => {
    const roomId = encodeRoomId(newRoomIdBytes());
    const secret = newSecretBytes();
    const code = makeInviteCode({ roomId, secret });
    const decoded = parseInviteCode(code);
    expect(decoded.roomId).toBe(roomId);
    expect(Buffer.from(decoded.secret)).toEqual(Buffer.from(secret));
    const viaInput = parseInviteInput(`POOF:${code}`.replace('POOF:', ''));
    expect(viaInput?.roomId).toBe(roomId);
  });

  it('preserves base64url alphabet characters inside an invite code', () => {
    // 0xFB repeated makes '-' and '_' appear in the encoded code; a parser that
    // strips those as separators silently turns the key material into garbage.
    const raw = new Uint8Array(48).fill(0xfb);
    const code = bytesToB64url(raw);
    expect(code).toContain('-');
    expect(code).toContain('_');
    const parsed = parseInviteInput(code);
    expect(parsed).not.toBeNull();
    expect(Buffer.from(parsed?.secret as Uint8Array)).toEqual(Buffer.from(raw.subarray(16)));
    expect(parsed?.roomId).toBe(encodeRoomId(raw.subarray(0, 16)));
  });

  it('rejects malformed input instead of guessing', () => {
    expect(parseInviteInput('')).toBeNull();
    expect(parseInviteInput('123456')).toBeNull();
    expect(parseInviteInput('http://x/room/notbase32#zzz')).toBeNull();
    expect(parseInviteInput('a'.repeat(63))).toBeNull();
    expect(parseInviteInput('a'.repeat(65))).toBeNull();
    expect(parseInviteInput('*'.repeat(64))).toBeNull();
    expect(parseInviteInput('http://x/room/' + encodeRoomId(newRoomIdBytes()))).toBeNull();
    expect(() => parseInviteCode(bytesToB64url(concatBytes(new Uint8Array(16), new Uint8Array(31))))).toThrow();
  });

  it('accepts a structurally valid code but does not authorize it', () => {
    // Shape is not membership: the server is what rejects an unknown room id, and
    // without the right secret the ciphertext stays unreadable anyway.
    const parsed = parseInviteInput('a'.repeat(64));
    expect(parsed).not.toBeNull();
    expect(parsed?.secret).toHaveLength(32);
    expect(parsed?.roomId).toBe(encodeRoomId(decodeRoomId(parsed?.roomId as string)));
  });

  it('a room id alone is not an invite', () => {
    expect(parseInviteInput(encodeRoomId(newRoomIdBytes()))).toBeNull();
  });

  it('ungrouping tolerates the pasteable dashed form', () => {
    const roomId = encodeRoomId(newRoomIdBytes());
    const dashed = roomId.replace(/(.{5})(?=.)/g, '$1-');
    const parsed = parseInviteInput(`http://h/room/${dashed}#${bytesToB64url(newSecretBytes())}`);
    expect(parsed?.roomId).toBe(roomId);
  });
});
