import { gcm as gcmJs } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2.js';
import { NONCE_BYTES, TAG_BYTES } from '../constants';
import { randomBytes, utf8 } from '../encoding';

export type AeadEngine = 'noble-js' | 'webcrypto-subtle';

export interface CryptoCapability {
  csprng: boolean;
  subtle: boolean;
  secureContext: boolean;
  engine: AeadEngine;
  reason?: string;
}

function hasSubtle(): boolean {
  const c = globalThis.crypto as Crypto | undefined;
  return !!c && typeof c.subtle === 'object' && typeof c.subtle.importKey === 'function';
}

function hasCsprng(): boolean {
  const c = globalThis.crypto as Crypto | undefined;
  return !!c && typeof c.getRandomValues === 'function';
}

export function detectCrypto(): CryptoCapability {
  const csprng = hasCsprng();
  const subtle = hasSubtle();
  const w = globalThis.window as (Window & { isSecureContext?: boolean }) | undefined;
  const secureContext = typeof w?.isSecureContext === 'boolean' ? w.isSecureContext : true;
  if (!csprng) {
    return {
      csprng: false,
      subtle,
      secureContext,
      engine: 'noble-js',
      reason: 'crypto.getRandomValues is unavailable, so no key material can be produced'
    };
  }
  return {
    csprng: true,
    subtle,
    secureContext,
    engine: subtle ? 'webcrypto-subtle' : 'noble-js'
  };
}

export class CryptoUnavailableError extends Error {
  code = 'CRYPTO_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'CryptoUnavailableError';
  }
}

export function assertCryptoUsable(cap: CryptoCapability = detectCrypto()): CryptoCapability {
  if (!cap.csprng) throw new CryptoUnavailableError(cap.reason ?? 'CSPRNG unavailable');
  return cap;
}

function checkKey(key: Uint8Array): void {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
}

function checkNonce(nonce: Uint8Array): void {
  if (nonce.length !== NONCE_BYTES) throw new Error('AES-256-GCM nonce must be 12 bytes');
}

/**
 * AES-256-GCM. Prefers the browser/Node WebCrypto implementation when present and
 * falls back to @noble/ciphers, which does not require a secure context. Both emit
 * the same layout: ciphertext || 16-byte tag.
 */
export async function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  checkKey(key);
  checkNonce(nonce);
  if (hasSubtle()) {
    const c = globalThis.crypto as Crypto;
    const ck = await c.subtle.importKey('raw', key as unknown as BufferSource, 'AES-GCM', false, [
      'encrypt'
    ]);
    return new Uint8Array(
      await c.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as BufferSource,
          additionalData: aad as unknown as BufferSource,
          tagLength: TAG_BYTES * 8
        },
        ck,
        plaintext as unknown as BufferSource
      )
    );
  }
  return gcmJs(key, nonce, aad).encrypt(plaintext);
}

export async function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  checkKey(key);
  checkNonce(nonce);
  if (ciphertext.length < TAG_BYTES) throw new Error('ciphertext shorter than auth tag');
  if (hasSubtle()) {
    const c = globalThis.crypto as Crypto;
    const ck = await c.subtle.importKey('raw', key as unknown as BufferSource, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(
      await c.subtle.decrypt({ name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: TAG_BYTES * 8 }, ck, ciphertext as unknown as BufferSource)
    );
  }
  return gcmJs(key, nonce, aad).decrypt(ciphertext);
}

export function hkdfSha256(secret: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha256, secret, '', info, length);
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

export function hmacNonce(key: Uint8Array, material: string): Uint8Array {
  return hmacSha256(key, utf8(material)).subarray(0, NONCE_BYTES);
}

export function generateKeyBytes(length: number): Uint8Array {
  assertCryptoUsable();
  return randomBytes(length);
}

/** Zero the buffer so callers can drop key material deterministically. */
export function wipe(b: Uint8Array | undefined | null): void {
  if (b) b.fill(0);
}
