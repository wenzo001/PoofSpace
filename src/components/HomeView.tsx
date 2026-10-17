'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Avatar from '@/components/Avatar';
import Modal from '@/components/Modal';
import NicknameDialog from '@/components/NicknameDialog';
import { LockIcon } from '@/components/icons';
import { RoomClient } from '@/lib/client/roomclient';
import { credentialsFromClient, clientOptions, canonicalRoomId } from '@/lib/client/runtime';
import { parseInviteInput } from '@/lib/crypto/invite';
import * as vault from '@/lib/client/vault';
import type { VaultEntry } from '@/lib/client/vault';
import { useNick } from '@/lib/client/identity';

type RowState = 'checking' | 'active' | 'unknown';

interface Row {
  roomId: string;
  state: RowState;
  online: number;
}

function toRows(entries: VaultEntry[]): Row[] {
  return entries.map((e) => ({ roomId: e.roomId, state: 'checking' as RowState, online: e.lastOnline ?? 0 }));
}

export default function HomeView() {
  const nickState = useNick();
  const [rows, setRows] = useState<Row[]>([]);
  const [joined, setJoined] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showNick, setShowNick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const entries = vault.list();
    setRows(toRows(entries));
    setJoined(entries.length > 0);
    await Promise.all(
      entries.map(async (entry) => {
        const settle = (patch: Partial<Row>) =>
          setRows((prev) => prev.map((r) => (r.roomId === entry.roomId ? { ...r, ...patch } : r)));
        const opts = clientOptions();
        const roomId = canonicalRoomId(entry.roomId);
        if (!opts || !roomId) {
          vault.remove(entry.roomId);
          setRows((prev) => prev.filter((r) => r.roomId !== entry.roomId));
          return;
        }
        try {
          const secret = vault.secretOf(entry);
          const probe = RoomClient.fromSecret(opts, { roomId, secret }, entry.roomId);
          const status = await probe.verifyRoomAlive();
          if (status === 'ACTIVE') {
            settle({ state: 'active' });
            return;
          }
          if (status === 'DESTROYED') {
            vault.remove(roomId);
            setRows((prev) => prev.filter((r) => r.roomId !== roomId));
            return;
          }
          settle({ state: 'unknown' });
        } catch {
          // A credential that cannot even be re-derived is dead on this device.
          vault.remove(entry.roomId);
          setRows((prev) => prev.filter((r) => r.roomId !== entry.roomId));
        }
      })
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (nick?: string) => {
    setBusy(true);
    setError(null);
    try {
      const opts = clientOptions();
      if (!opts) throw new Error('当前环境不支持端到端加密');
      const client = await RoomClient.createRoom(opts, nick || nickState.nick);
      const parts = credentialsFromClient(client);
      if (!parts) throw new Error('房间凭据生成失败');
      vault.put({ roomId: parts.roomId, secret: parts.secret, creatorToken: client.creatorToken });
      window.location.assign(`/room/${parts.roomId}`);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  const enter = (input: string) => {
    const parts = parseInviteInput(input);
    if (!parts) {
      setError('邀请链接或口令无效');
      return;
    }
    vault.put({ roomId: parts.roomId, secret: parts.secret });
    window.location.assign(`/room/${parts.roomId}`);
  };

  // The first create/join has to settle the device's name; afterwards only an explicit edit changes it.
  const pending = useRef<{ kind: 'create' } | { kind: 'join'; code: string } | null>(null);

  const guard = (intent: { kind: 'create' } | { kind: 'join'; code: string }): boolean => {
    if (nickState.confirmed) return true;
    pending.current = intent;
    setShowJoin(false);
    setShowNick(true);
    return false;
  };

  const confirmNick = (raw: string) => {
    const name = nickState.apply(raw);
    const intent = pending.current;
    pending.current = null;
    if (!intent) return;
    if (intent.kind === 'create') void create(name);
    else enter(intent.code);
  };

  return (
    <div className="shell">
      <header className="nav">
        <div className="brand">
          <LockIcon />
          <b>PoofSpace</b>
        </div>
        <button type="button" className="me" onClick={() => setShowNick(true)}>
          <Avatar nick={nickState.nick || '未命名'} small />
          <span className="name">{nickState.nick || '未命名'}</span>
        </button>
      </header>

      <main className="hero">
        <span className="eyebrow">TEMPORARY · 临时聊天室 · 免注册</span>
        <h1 className="headline">创建即聊，离开即焚。</h1>
        <p className="sub">无需账号，生成房间即可分享；端到端加密，最后一人离开后倒计时销毁（默认 5 分钟，房主可一次性延长）。</p>
        <div className="btnrow">
          <button type="button" className="btn btn-primary" onClick={() => { if (guard({ kind: 'create' })) void create(); }} disabled={busy}>
            {busy ? '创建中…' : '创建聊天室'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setShowJoin(true)}>
            加入聊天室
          </button>
        </div>
        {error ? <span className="notice-error">{error}</span> : <span className="hint">房间凭据只保存在这台设备上。</span>}
        <div className="trust">
          <span className="dot" />
          服务器只保存密文 · 不保存聊天记录明文
        </div>
      </main>

      {rows.length > 0 ? (
        <section className="section">
          <h2 className="section-title">历史</h2>
          <div className="list-plain">
            {rows.map((row) => (
              <div className="vault-item" key={row.roomId}>
                <div className="col">
                  <span className="rid">#{row.roomId}</span>
                  <span className="when">
                    {row.state === 'checking' ? '校验中…' : row.state === 'unknown' ? '暂时无法校验' : '房间仍在进行'}
                    {row.state === 'active' && row.online > 0 ? ` · 上次 ${row.online} 人在线` : ''}
                  </span>
                </div>
                {row.state === 'active' ? (
                  <a className="link-btn" href={`/room/${row.roomId}`}>
                    恢复进入
                  </a>
                ) : (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={row.state === 'checking'}
                    onClick={() => void load()}
                  >
                    {row.state === 'checking' ? '校验中' : '重新校验'}
                  </button>
                )}
              </div>
            ))}
          </div>
          <span className="cap">每次恢复都会先向服务器确认房间仍然存在；已销毁的房间会立即从本机移除。</span>
        </section>
      ) : null}

      {joined ? null : (
        <footer className="footer">端到端加密 · 无账号 · 无社交关系</footer>
      )}

      {showJoin ? (
        <Modal title="加入聊天室" onClose={() => setShowJoin(false)}>
          <span className="label">粘贴邀请链接或邀请口令。</span>
          <JoinForm error={error} onSubmit={(v) => { if (guard({ kind: 'join', code: v })) enter(v); }} />
          <span className="cap">链接 # 之后的密钥只在浏览器本地使用，不会发送给服务器。</span>
        </Modal>
      ) : null}

      {showNick ? (
        <NicknameDialog
          nick={nickState.nick}
          first={!nickState.confirmed}
          onClose={() => {
            // Backing out of the prompt must also drop what it was standing in front of, or the
            // next time the reader edits their name they get a room created out of nowhere.
            pending.current = null;
            setShowNick(false);
          }}
          onApply={confirmNick}
        />
      ) : null}
    </div>
  );
}

function JoinForm({ error, onSubmit }: { error: string | null; onSubmit: (input: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="list-plain"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div className="field">
        <input
          value={value}
          placeholder="https://…/room/XXXX#… 或邀请口令"
          onChange={(e) => setValue(e.target.value)}
          aria-label="邀请链接或口令"
          autoFocus
        />
      </div>
      {error ? <span className="notice-error">{error}</span> : null}
      <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
        进入房间
      </button>
    </form>
  );
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string };
  if (e?.code === 'CRYPTO_UNAVAILABLE') return '此浏览器环境无法安全生成密钥，已阻止创建房间。';
  if (e?.message?.includes('room create failed')) return '房间创建失败，请稍后重试。';
  return e?.message ?? '发生未知错误';
}
