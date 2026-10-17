import type { RoomClient } from './roomclient';
import { DecryptError, type AttachmentMeta } from '../crypto/envelope';

const THUMB_EDGE = 480;

interface Entry {
  refs: number;
  thumb?: string;
  thumbPending?: Promise<string | null>;
  full?: string;
  fullPending?: Promise<string | null>;
}

const entries = new Map<string, Entry>();

function entry(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = { refs: 0 };
    entries.set(id, e);
  }
  return e;
}

function revoke(url: string | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

/** Drop the decoded preview as soon as a row leaves the screen; the row can re-create it later. */
function collect(id: string): void {
  const e = entries.get(id);
  if (!e || e.refs > 0) return;
  revoke(e.thumb);
  revoke(e.full);
  entries.delete(id);
}

export function retain(id: string): void {
  entry(id).refs++;
}

export function release(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  collect(id);
}

async function decrypt(client: RoomClient, id: string, mime: string): Promise<Blob> {
  const bytes = await client.download(id);
  return new Blob([bytes as unknown as BlobPart], { type: mime || 'application/octet-stream' });
}

/**
 * The original pixel size, read once before upload. The thumbnail path below decodes the file,
 * learns these numbers and throws them away; the viewer needs them up front, because inferring
 * them after the image loads would re-measure the layout at the moment the pixels arrive -- the
 * same class of jump the scroll hold has to compensate for.
 */
export async function imageDims(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return null;
  }
}

export async function thumbnailUrl(client: RoomClient, id: string, meta: AttachmentMeta): Promise<string | null> {
  const e = entry(id);
  if (e.thumb) return e.thumb;
  if (e.thumbPending) return e.thumbPending;
  const work = (async () => {
    try {
      const blob = await decrypt(client, id, meta.mime);
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const out = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.85));
      if (!out) return null;
      const url = URL.createObjectURL(out);
      const cur = entries.get(id);
      if (!cur || cur.refs === 0) return null;
      cur.thumb = url;
      return url;
    } catch (err) {
      // An authentication failure is a security event, not a missing preview.
      if (err instanceof DecryptError) throw err;
      return null;
    } finally {
      const cur = entries.get(id);
      if (cur) cur.thumbPending = undefined;
    }
  })();
  e.thumbPending = work;
  return work;
}

export async function fullUrl(client: RoomClient, id: string, meta: AttachmentMeta): Promise<string | null> {
  const e = entry(id);
  if (e.full) return e.full;
  if (e.fullPending) return e.fullPending;
  const work = (async () => {
    try {
      const blob = await decrypt(client, id, meta.mime);
      const url = URL.createObjectURL(blob);
      const cur = entries.get(id);
      if (!cur || cur.refs === 0) {
        URL.revokeObjectURL(url);
        return null;
      }
      cur.full = url;
      return url;
    } catch (err) {
      if (err instanceof DecryptError) throw err;
      return null;
    } finally {
      const cur = entries.get(id);
      if (cur) cur.fullPending = undefined;
    }
  })();
  e.fullPending = work;
  return work;
}

/**
 * The thumbnail this device already has in memory, without starting any new work. The viewer uses
 * it as the slide's first `src` so paging never shows an empty frame while the full image is still
 * coming off the wire -- and an attachment no row has rendered stays empty rather than quietly
 * decoding a second copy.
 */
export function cachedThumb(id: string): string | undefined {
  return entries.get(id)?.thumb;
}

export function dropFull(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  revoke(e.full);
  e.full = undefined;
}

/** Untrusted filename: control characters and path separators never reach the download name. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return cleaned.slice(0, 180) || 'file';
}

export async function saveFile(client: RoomClient, id: string, meta: AttachmentMeta): Promise<void> {
  const blob = await decrypt(client, id, meta.mime);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(meta.name);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000).unref?.();
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* http origins have no async clipboard */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
