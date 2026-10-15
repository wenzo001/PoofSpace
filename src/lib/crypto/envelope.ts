import { LIMITS, MAX_COUNTER, MAX_GEN, NONCE_BYTES, PROTO_TAG } from '../constants';
import { b64ToBytes, bytesToB64, concatBytes, fromUtf8, utf8, writeUintBE } from '../encoding';
import { aeadDecrypt, aeadEncrypt, hmacNonce } from './engine';

export interface NonceContext {
  slot: number;
  gen: number;
}

/**
 * nonce = tag(1) || slot(3) || gen(2) || counter(6)
 *
 * slot is allocated by the server and unique inside a room; gen increases on every
 * re-issue of a slot; counter is monotonic within one (slot, gen) pair, so two
 * different plaintexts can never share a (key, nonce) pair.
 */
export function buildNonce(ctx: NonceContext, counter: number): Uint8Array {
  if (!Number.isInteger(ctx.slot) || ctx.slot < 0 || ctx.slot > 0xffffff) throw new Error('slot out of range');
  if (!Number.isInteger(ctx.gen) || ctx.gen < 0 || ctx.gen > MAX_GEN) throw new Error('gen out of range');
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) throw new Error('nonce counter exhausted');
  const n = new Uint8Array(NONCE_BYTES);
  n[0] = 1;
  n.set(writeUintBE(ctx.slot, 3), 1);
  n.set(writeUintBE(ctx.gen, 2), 4);
  n.set(writeUintBE(counter, 6), 6);
  return n;
}

export function parseNonce(n: Uint8Array): { slot: number; gen: number; counter: number } {
  if (n.length !== NONCE_BYTES) throw new Error('bad nonce length');
  const be = (from: number, len: number) => {
    let v = 0;
    for (let i = from; i < from + len; i++) v = v * 256 + (n[i] as number);
    return v;
  };
  return { slot: be(1, 3), gen: be(4, 2), counter: be(6, 6) };
}

function readUintBE(b: Uint8Array, from: number, len: number): number {
  let v = 0;
  for (let i = from; i < from + len; i++) v = v * 256 + (b[i] as number);
  return v;
}

function be(v: number, len: number): Uint8Array {
  return writeUintBE(v, len);
}

export class DecryptError extends Error {
  code = 'DECRYPT_FAILED';
  constructor(reason: string) {
    super(`AEAD authentication failed: ${reason}`);
    this.name = 'DecryptError';
  }
}

export interface EncryptedEnvelope {
  nonce: Uint8Array;
  ct: Uint8Array;
}

export interface TextPayload {
  kind: 'text';
  body: string;
}

export interface AttachmentPayload {
  kind: 'file' | 'image';
  attachmentId: string;
}

export type MessagePayload = TextPayload | AttachmentPayload;

export function messageAAD(roomId: string, clientMsgId: string): Uint8Array {
  return utf8(`${PROTO_TAG}|msg|${roomId}|${clientMsgId}`);
}

export async function sealMessage(
  msgKey: Uint8Array,
  ctx: NonceContext,
  counter: number,
  roomId: string,
  clientMsgId: string,
  payload: MessagePayload
): Promise<EncryptedEnvelope> {
  const plaintext = utf8(JSON.stringify(payload));
  if (plaintext.length > LIMITS.textPlaintextBytes) throw new Error('message too large');
  const nonce = buildNonce(ctx, counter);
  const ct = await aeadEncrypt(msgKey, nonce, messageAAD(roomId, clientMsgId), plaintext);
  if (ct.length > LIMITS.textCiphertextBytes) throw new Error('ciphertext too large');
  return { nonce, ct };
}

export async function openMessage(
  msgKey: Uint8Array,
  roomId: string,
  clientMsgId: string,
  env: { nonce: Uint8Array | string; ct: Uint8Array | string }
): Promise<MessagePayload> {
  const nonce = typeof env.nonce === 'string' ? b64ToBytes(env.nonce) : env.nonce;
  const ct = typeof env.ct === 'string' ? b64ToBytes(env.ct) : env.ct;
  let plain: Uint8Array;
  try {
    plain = await aeadDecrypt(msgKey, nonce, messageAAD(roomId, clientMsgId), ct);
  } catch {
    throw new DecryptError('message');
  }
  const obj = JSON.parse(fromUtf8(plain)) as MessagePayload;
  if (obj.kind !== 'text' && obj.kind !== 'file' && obj.kind !== 'image') throw new DecryptError('unknown payload kind');
  if (obj.kind === 'text' && typeof obj.body !== 'string') throw new DecryptError('bad text payload');
  if (obj.kind !== 'text' && typeof obj.attachmentId !== 'string') throw new DecryptError('bad attachment payload');
  return obj;
}

export function chunkAAD(roomId: string, attachmentId: string, index: number): Uint8Array {
  return utf8(`${PROTO_TAG}|chunk|${roomId}|${attachmentId}|${index}`);
}

/** On-disk / on-wire chunk layout: nonce(12) || ciphertext || tag(16). */
export async function sealChunk(
  fileKey: Uint8Array,
  ctx: NonceContext,
  counter: number,
  roomId: string,
  attachmentId: string,
  index: number,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const nonce = buildNonce(ctx, counter);
  const ct = await aeadEncrypt(fileKey, nonce, chunkAAD(roomId, attachmentId, index), plaintext);
  return concatBytes(nonce, ct);
}

export async function openChunk(
  fileKey: Uint8Array,
  roomId: string,
  attachmentId: string,
  index: number,
  frame: Uint8Array
): Promise<Uint8Array> {
  if (frame.length < NONCE_BYTES + 16) throw new DecryptError('chunk frame truncated');
  const nonce = frame.subarray(0, NONCE_BYTES);
  const ct = frame.subarray(NONCE_BYTES);
  try {
    return await aeadDecrypt(fileKey, nonce, chunkAAD(roomId, attachmentId, index), ct);
  } catch {
    throw new DecryptError('chunk');
  }
}

export function metaAAD(roomId: string, attachmentId: string): Uint8Array {
  return utf8(`${PROTO_TAG}|meta|${roomId}|${attachmentId}`);
}

export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  kind: 'file' | 'image';
  width?: number;
  height?: number;
  textFallback?: string;
}

export interface SealedMeta extends EncryptedEnvelope {}

/**
 * Attachment metadata is deterministic per attachment, so the nonce is derived from
 * the metadata key plus the attachment id rather than a counter: re-sealing the same
 * input can never pair a nonce with a different plaintext.
 */
export async function sealMeta(
  metaKey: Uint8Array,
  roomId: string,
  attachmentId: string,
  meta: AttachmentMeta
): Promise<EncryptedEnvelope> {
  const nonce = hmacNonce(metaKey, `${PROTO_TAG}|meta-n|${roomId}|${attachmentId}`);
  const ct = await aeadEncrypt(metaKey, nonce, metaAAD(roomId, attachmentId), utf8(JSON.stringify(meta)));
  return { nonce, ct };
}

export async function openMeta(
  metaKey: Uint8Array,
  roomId: string,
  attachmentId: string,
  env: { nonce: Uint8Array | string; ct: Uint8Array | string }
): Promise<AttachmentMeta> {
  const nonce = typeof env.nonce === 'string' ? b64ToBytes(env.nonce) : env.nonce;
  const ct = typeof env.ct === 'string' ? b64ToBytes(env.ct) : env.ct;
  let plain: Uint8Array;
  try {
    plain = await aeadDecrypt(metaKey, nonce, metaAAD(roomId, attachmentId), ct);
  } catch {
    throw new DecryptError('attachment metadata');
  }
  const meta = JSON.parse(fromUtf8(plain)) as AttachmentMeta;
  if (typeof meta.name !== 'string' || typeof meta.size !== 'number' || typeof meta.chunkCount !== 'number') {
    throw new DecryptError('attachment metadata shape');
  }
  if (meta.chunkCount <= 0 || meta.chunkSize <= 0) throw new DecryptError('attachment chunk geometry');
  if (meta.size > meta.chunkCount * meta.chunkSize) throw new DecryptError('attachment size inconsistent');
  return meta;
}

export function expectedChunkPlaintextSize(meta: AttachmentMeta, index: number): number {
  if (index < meta.chunkCount - 1) return meta.chunkSize;
  const rest = meta.size - (meta.chunkCount - 1) * meta.chunkSize;
  return rest;
}

export function chunkCounterForIndex(index: number): number {
  return index + 1;
}

export { readUintBE, be };
