import type { AttachmentMeta } from '../crypto/envelope';
import type { ClientEvent, RoomClient, SendState } from './roomclient';
import { ERR } from '../constants';

export interface UiMsg {
  id: string;
  seq: number;
  slot: number;
  kind: 'text' | 'file' | 'image';
  text: string;
  attachmentId?: string;
  at: number;
  state: SendState;
  own: boolean;
  error?: string;
  senderNick: string;
}

export interface UiMember {
  slot: number;
  nick: string;
  online: boolean;
  isCreator: boolean;
}

export interface RoomSnapshot {
  status: 'connecting' | 'open' | 'closed' | 'destroyed';
  messages: UiMsg[];
  members: UiMember[];
  online: number;
  hasMore: boolean;
  loadingOlder: boolean;
  uploads: Record<string, { sent: number; total: number }>;
  metas: Record<string, AttachmentMeta>;
  /** Set when app-layer encryption could not be verified or AEAD authentication failed. */
  blocked: string | null;
  fatal: string | null;
  notice: string | null;
  rev: number;
}

const UNKNOWN_NICK = '未知成员';

export class RoomStore {
  private readonly client: RoomClient;
  private readonly unsub: () => void;
  private readonly listeners = new Set<() => void>();
  private raw = new Map<string, UiMsg>();
  private nickBySlot = new Map<number, string>();
  private uploads: Record<string, { sent: number; total: number }> = {};
  private metas: Record<string, AttachmentMeta> = {};
  private metaRequests = new Map<string, Promise<AttachmentMeta | null>>();
  private snapshot: RoomSnapshot;
  private dirty = true;
  private scheduled = false;
  private hasMore = true;
  private loadingOlder = false;
  private blocked: string | null = null;
  private fatal: string | null = null;
  private notice: string | null = null;
  private rev = 0;

  constructor(client: RoomClient) {
    this.client = client;
    this.snapshot = this.build();
    this.unsub = client.on((e) => this.handle(e));
  }

  dispose(): void {
    this.unsub();
    this.listeners.clear();
    this.raw.clear();
    this.metaRequests.clear();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getSnapshot(): RoomSnapshot {
    if (this.dirty) {
      this.snapshot = this.build();
      this.dirty = false;
    }
    return this.snapshot;
  }

  /** Attachment metadata is only ever fetched once per id and stays in memory. */
  metaFor(attachmentId: string): AttachmentMeta | undefined {
    const cached = this.metas[attachmentId];
    if (cached) return cached;
    void this.loadMeta(attachmentId);
    return undefined;
  }

  private loadMeta(attachmentId: string): Promise<AttachmentMeta | null> {
    const inflight = this.metaRequests.get(attachmentId);
    if (inflight) return inflight;
    const p = this.client
      .readMeta(attachmentId)
      .then((m) => {
        this.metas = { ...this.metas, [attachmentId]: m };
        this.markDirty();
        return m;
      })
      .catch(() => null)
      .finally(() => this.metaRequests.delete(attachmentId));
    this.metaRequests.set(attachmentId, p);
    return p;
  }

  setBlocked(reason: string): void {
    this.blocked = reason;
    this.markDirty();
  }

  setNotice(text: string): void {
    this.notice = text;
    this.markDirty();
  }

  clearNotice(): void {
    this.notice = null;
    this.markDirty();
  }

  beginLoadOlder(): void {
    this.loadingOlder = true;
    this.markDirty();
  }

  endLoadOlder(): void {
    this.loadingOlder = false;
    this.markDirty();
  }

  markOlderEmpty(): void {
    this.hasMore = false;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.dirty) return;
      this.snapshot = this.build();
      this.dirty = false;
      for (const l of this.listeners) l();
    });
  }

  private handle(e: ClientEvent): void {
    switch (e.type) {
      case 'message': {
        const msg = e.msg;
        this.raw.set(msg.clientMsgId, {
          id: msg.clientMsgId,
          seq: msg.seq,
          slot: msg.slot,
          kind: msg.kind,
          text: msg.text,
          attachmentId: msg.attachmentId,
          at: msg.at,
          state: msg.state,
          own: msg.own,
          senderNick: msg.own ? this.client.nick : (this.nickBySlot.get(msg.slot) ?? UNKNOWN_NICK)
        });
        if (msg.attachment && msg.attachmentId) {
          this.metas = { ...this.metas, [msg.attachmentId]: msg.attachment };
        }
        this.markDirty();
        return;
      }
      case 'message-state': {
        const cur = this.raw.get(e.clientMsgId);
        if (!cur) return;
        this.raw.set(e.clientMsgId, { ...cur, state: e.state, error: e.error });
        this.markDirty();
        return;
      }
      case 'members': {
        for (const m of e.members) {
          this.nickBySlot.set(m.slot, m.nickPlain ?? UNKNOWN_NICK);
        }
        this.markDirty();
        return;
      }
      case 'history-loaded': {
        this.hasMore = e.hasMore;
        this.loadingOlder = false;
        this.markDirty();
        return;
      }
      case 'upload-progress': {
        this.uploads = { ...this.uploads, [e.attachmentId]: { sent: e.sent, total: e.total } };
        this.markDirty();
        return;
      }
      case 'connected':
      case 'disconnected':
        this.markDirty();
        return;
      case 'destroying':
        this.notice = '房主正在销毁房间';
        this.markDirty();
        return;
      case 'destroyed':
        this.fatal = e.reason === 'creator' ? '房间已被销毁' : '房间已销毁（无人在线或服务器关闭）';
        this.markDirty();
        return;
      case 'error': {
        if (e.code === ERR.decryptFailed || e.code === ERR.authFailed || e.code === ERR.cryptoUnavailable) {
          this.blocked = '端到端加密校验失败，已停止发送。消息认证未通过，内容可能已被篡改。';
        } else {
          this.notice = e.message;
        }
        if (e.code === ERR.roomDestroyed || e.code === ERR.roomNotFound || e.code === ERR.badSecret || e.code === ERR.badProof) {
          this.fatal = '无法进入该房间：链接已失效或凭据不正确。';
        }
        this.markDirty();
        return;
      }
      default:
        return;
    }
  }

  private sortThenMap(): UiMsg[] {
    const out = [...this.raw.values()];
    out.sort((a, b) => {
      const sa = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
      const sb = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.at - b.at;
    });
    return out;
  }

  private build(): RoomSnapshot {
    const messages = this.sortThenMap();
    const members: UiMember[] = this.client.members.map((m) => ({
      slot: m.slot,
      nick: m.nickPlain ?? this.nickBySlot.get(m.slot) ?? UNKNOWN_NICK,
      online: m.online,
      isCreator: m.isCreator
    }));
    return {
      status: this.client.status === 'new' ? 'connecting' : this.client.status,
      messages,
      members,
      online: members.filter((m) => m.online).length,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      uploads: this.uploads,
      metas: this.metas,
      blocked: this.blocked,
      fatal: this.fatal,
      notice: this.notice,
      rev: ++this.rev
    };
  }
}
