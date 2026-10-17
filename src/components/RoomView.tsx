'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Avatar from '@/components/Avatar';
import Modal from '@/components/Modal';
import PreviewHost from '@/components/PreviewHost';
import NicknameDialog from '@/components/NicknameDialog';
import {
  BellIcon,
  DownloadIcon,
  FileIcon,
  LockIcon,
  PaperclipIcon,
  WarnIcon
} from '@/components/icons';
import { RoomClient } from '@/lib/client/roomclient';
import { RoomStore, type RoomSnapshot, type UiMsg } from '@/lib/client/roomstore';
import { LIMITS } from '@/lib/constants';
import { DecryptError, type AttachmentMeta } from '@/lib/crypto/envelope';
import { copyText, formatBytes, formatTime, imageDims, release, retain, saveFile, thumbnailUrl } from '@/lib/client/media';
import { currentPermission, notifyEncrypted, requestPermission } from '@/lib/client/notify';
import { loadPrefs, setNotifyOptIn } from '@/lib/client/prefs';
import { useNick } from '@/lib/client/identity';
import * as vault from '@/lib/client/vault';
import { canonicalRoomId, clientOptions, credentialsFromClient, secretFromFragment } from '@/lib/client/runtime';
import { wipe } from '@/lib/crypto/engine';
import { useVirtualList } from '@/lib/client/virtuoso';

const EXCERPT_CHARS = 180;
const EXCERPT_LINES = 6;
const ROW_ESTIMATE = 84;

const EMPTY_SNAPSHOT: RoomSnapshot = {
  status: 'connecting',
  messages: [],
  members: [],
  online: 0,
  hasMore: true,
  loadingOlder: false,
  uploads: {},
  metas: {},
  metaGaps: [],
  blocked: null,
  fatal: null,
  notice: null,
  rev: 0
};

interface Session {
  client: RoomClient;
  store: RoomStore;
}

interface UploadJob {
  key: string;
  name: string;
  size: number;
  kind: 'file' | 'image';
  file: File;
  state: 'queued' | 'uploading' | 'failed';
  sent: number;
  total: number;
  error?: string;
}

const NICK_FALLBACK = '我';

/** The lock is only allowed to state what has actually been verified, never more. */
function securityCopy(secure: boolean): string {
  return secure
    ? '消息和文件在设备端加密，服务器无法直接读取内容。当前连接使用 HTTPS。'
    : '消息和文件采用端到端加密，但 HTTP 连接本身未加密，网络中的攻击者可能篡改网页代码。建议在不可信网络中使用 HTTPS。';
}

function joinErrorMessage(code: string): string {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return '房间不存在，或已经被销毁。';
    case 'ROOM_DESTROYED':
    case 'ROOM_DESTROYING':
      return '这个房间已经销毁，旧链接和旧邀请码都无法再进入。';
    case 'ROOM_FULL':
      return '房间人数已达上限。';
    case 'MAINTENANCE':
      return '服务器正在维护，请稍后重新进入。';
    case 'BAD_PROOF':
    case 'BAD_SECRET':
      return '邀请密钥不正确，无法解密这个房间。';
    case 'RATE_LIMITED':
      return '操作过于频繁，请稍后再试。';
    default:
      return `无法进入房间：${code}`;
  }
}

export default function RoomView({ roomId: roomIdProp }: { roomId: string }) {
  const nickState = useNick();
  const [sess, setSess] = useState<Session | null>(null);
  const [fatal, setFatal] = useState<{ title: string; body: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showNick, setShowNick] = useState(false);
  const [showDestroy, setShowDestroy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [notifyPerm, setNotifyPerm] = useState<string>('unsupported');
  const [draft, setDraft] = useState('');
  const [tipOpen, setTipOpen] = useState(false);
  const [viewer, setViewer] = useState<{ ids: string[]; index: number } | null>(null);

  const subscribe = useMemo(() => (sess ? (cb: () => void) => sess.store.subscribe(cb) : () => () => {}), [sess]);
  const getSnapshot = useMemo(() => () => (sess ? sess.store.getSnapshot() : EMPTY_SNAPSHOT), [sess]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The home page shows this number later, so it has to be captured while inside. Polling it from
  // there would mean joining, and joining cancels the room's idle-destroy countdown.
  useEffect(() => {
    if (roomIdProp && snap.online > 0) vault.noteOnline(roomIdProp, snap.online);
  }, [roomIdProp, snap.online]);

  const keys = useMemo(() => snap.messages.map((m) => m.id), [snap.messages]);
  const virt = useVirtualList(keys, { estimate: ROW_ESTIMATE });

  const fileInput = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const acceptedRef = useRef(false);
  const busyLoad = useRef(false);
  const activeUpload = useRef(false);
  const currentUploadKey = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = sess;

  // The click handler has to see the message list as it is *now*, but it is handed to a row that
  // must not re-render on every keystroke in the composer. So the identity is permanent and the
  // body is whatever the latest render wrote into the ref — a `useCallback` over `snap.messages`
  // would have to list the snapshot as a dependency and re-render every row with it.
  const openImageRef = useRef<(attachmentId: string) => void>(() => {});
  const openImage = useCallback((attachmentId: string) => openImageRef.current(attachmentId), []);

  // Device-local state, so it cannot be known while rendering on the server. Assuming `true` there
  // put "当前连接使用 HTTPS。" into the HTML of a plain-http response — measured, not inferred: with
  // that line the served bytes carry the claim and the gate below goes red. A tooltip that is in
  // the first paint is something a user can be shown before hydration has anything to say, so the
  // conservative copy is what may be written into the document, and the effect corrects it after.
  const [secure, setSecure] = useState(false);
  useEffect(() => {
    setSecure(window.location.protocol === 'https:');
  }, []);
  const blocked = snap.blocked;

  const reportAuthFailure = useCallback(() => {
    sess?.store.setBlocked('端到端加密校验失败，附件内容可能已被篡改，已停止展示与下载。');
  }, [sess]);

  // ------------------------------------------------------------------ session
  useEffect(() => {
    // Entering a room means being named in it, so the first-run confirmation has to happen before
    // any credential is stored or any join is attempted.
    if (!nickState.confirmed) return;
    let disposed = false;
    const roomId = canonicalRoomId(roomIdProp);
    if (!roomId) {
      setFatal({ title: '房间地址无效', body: '链接里的房间 ID 无法识别，请重新打开完整的邀请链接。' });
      return;
    }
    const entry = vault.get(roomId);
    const fromFragment = secretFromFragment(window.location.hash.replace(/^#/, ''));
    const secret = fromFragment ?? (entry ? secretFromFragment(entry.secret) : null);
    if (!secret) {
      setFatal({ title: '缺少房间密钥', body: '邀请链接 # 之后的密钥只保存在浏览器本地，这条地址里没有它，因此无法解密。' });
      return;
    }
    vault.put({ roomId, secret, creatorToken: entry?.creatorToken });
    // The credential is now in the device vault, so drop it from the address bar.
    window.history.replaceState(null, '', window.location.pathname);

    let client: RoomClient;
    try {
      // useNick delivers the cached name one commit after mount, so this effect would otherwise
      // join with the empty string and put the device into the room as the fallback word.
      // Reading prefs here is safe: it happens after hydration, never during render.
      client = RoomClient.fromSecret(clientOptions(), { roomId, secret }, nickState.nick || loadPrefs().nick || NICK_FALLBACK);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setFatal({
        title: '端到端加密不可用',
        body: e?.code === 'CRYPTO_UNAVAILABLE' ? '当前浏览器无法安全生成随机密钥，已阻止创建会话。' : (e?.message ?? '加密初始化失败。')
      });
      return;
    } finally {
      wipe(secret);
    }
    client.creatorToken = entry?.creatorToken ?? '';
    const store = new RoomStore(client);
    if (!client.capability.csprng) {
      store.setBlocked('随机数生成器不可用，已阻止发送任何敏感内容。');
    }
    const off = client.on((e) => {
      if (disposed) return;
      if (e.type === 'message' && !e.msg.own) notifyEncrypted();
      if (e.type === 'destroyed') {
        vault.remove(roomId);
        // Nothing left to render: leave the dead room and go home, with the credential already
        // dropped so the history list cannot offer to re-enter it.
        client.close();
        window.location.assign('/');
      }
    });
    setSess({ client, store });

    client
      .connect()
      .then(() => client.loadOlder())
      .catch((err: Error) => {
        if (disposed) return;
        const code = err.message;
        setFatal({ title: '无法进入房间', body: joinErrorMessage(code) });
        if (code === 'ROOM_NOT_FOUND' || code === 'ROOM_DESTROYED' || code === 'BAD_SECRET' || code === 'BAD_PROOF') {
          vault.remove(roomId);
        }
      });

    return () => {
      disposed = true;
      off();
      store.dispose();
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIdProp, nickState.confirmed]);

  // Best-effort departure: the server also has a heartbeat timeout as a backstop.
  useEffect(() => {
    const bye = () => sessionRef.current?.client.close();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  useEffect(() => {
    setNotifyPerm(currentPermission());
  }, []);

  useEffect(() => {
    if (!snap.notice) return;
    const t = setTimeout(() => sess?.store.clearNotice(), 6000);
    return () => clearTimeout(t);
  }, [snap.notice, sess]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.min(132, Math.max(44, node.scrollHeight))}px`;
  }, [draft]);

  // ------------------------------------------------------------------- upload
  useEffect(() => {
    const client = sess?.client;
    if (!client || activeUpload.current) return;
    const job = jobs.find((j) => j.state === 'queued');
    if (!job) return;
    activeUpload.current = true;
    currentUploadKey.current = job.key;
    setJobs((prev) => prev.map((j) => (j.key === job.key ? { ...j, state: 'uploading', error: undefined } : j)));
    const slice = async (start: number, length: number) => {
      const part = job.file.slice(start, start + length);
      return new Uint8Array(await part.arrayBuffer());
    };
    // Read the original size before the transfer so it lands in the encrypted meta. A non-image, or
    // a file the browser declines to decode, uploads exactly as before with the fields left unset.
    const dims = job.kind === 'image' ? imageDims(job.file) : Promise.resolve(null);
    dims
      .then((size) =>
        client.upload({
          name: job.name,
          mime: job.file.type || 'application/octet-stream',
          size: job.file.size,
          kind: job.kind,
          width: size?.width,
          height: size?.height,
          slice
        })
      )
      .then(() => {
        // Released before the state update, never in a finally(): React flushes this render on a
        // microtask queued while the promise chain is still running, so a later release would let
        // the effect re-run against a held lock. The rest of the queue then waits forever.
        activeUpload.current = false;
        currentUploadKey.current = null;
        setJobs((prev) => prev.filter((j) => j.key !== job.key));
      })
      .catch((err: Error) => {
        activeUpload.current = false;
        currentUploadKey.current = null;
        setJobs((prev) => prev.map((j) => (j.key === job.key ? { ...j, state: 'failed', error: err.message } : j)));
      });
  }, [jobs, sess]);

  useEffect(() => {
    const client = sess?.client;
    if (!client) return;
    return client.on((e) => {
      if (e.type !== 'upload-progress') return;
      const key = currentUploadKey.current;
      if (!key) return;
      setJobs((prev) => prev.map((j) => (j.key === key ? { ...j, sent: e.sent, total: e.total } : j)));
    });
  }, [sess]);

  // One entry point, and the file itself decides how it renders: an image is an image whether it
  // came from the picker or from the clipboard, so `kind` is derived here instead of being passed
  // in by whichever button happened to be pressed.
  const enqueue = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const next: UploadJob[] = [];
    for (const file of Array.from(files)) {
      if (file.size > LIMITS.attachmentBytesMax) {
        sess?.store.setNotice(`附件超过 ${formatBytes(LIMITS.attachmentBytesMax)} 上限`);
        continue;
      }
      const kind: UploadJob['kind'] = file.type.startsWith('image/') ? 'image' : 'file';
      next.push({
        key: `${kind}-${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        kind,
        file,
        state: 'queued',
        sent: 0,
        total: Math.max(1, Math.ceil(file.size / LIMITS.chunkBytes))
      });
    }
    if (next.length) setJobs((prev) => [...prev, ...next]);
  };

  // Ctrl/Cmd+V anywhere on the page sends what the clipboard actually holds: a screenshot, an
  // image copied from another app, a file copied in Explorer/Finder. Text is left to the browser
  // so pasting into the input box keeps working exactly as it did. Every item on the clipboard is
  // taken, so copying several files queues them all.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const files: File[] = [];
      // Indexed walk rather than a spread: `DataTransferItemList` is array-like, and reading it by
      // index is the one form every engine implements.
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        const f = item && item.kind === 'file' ? item.getAsFile() : null;
        if (f) files.push(f);
      }
      if (files.length === 0) return;
      e.preventDefault();
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const named = files.map((f, i) => {
        const unnamed = !f.name || f.name === 'image.png' || f.name === 'blob';
        if (!unnamed) return f;
        const ext = (f.type.split('/')[1] || 'bin').split(';')[0];
        return new File([f], `${f.type.startsWith('image/') ? '粘贴图片' : '粘贴文件'}-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`, {
          type: f.type || 'application/octet-stream',
          lastModified: f.lastModified || Date.now()
        });
      });
      enqueue(named);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sess]);

  // -------------------------------------------------------------------- send
  const send = async () => {
    const client = sess?.client;
    if (!client) return;
    const body = draft.replace(/\n+$/, '');
    if (!body.trim()) return;
    const store = sess?.store;
    if (blocked) {
      store?.setBlocked('端到端加密校验未通过，已阻止发送。');
      return;
    }
    if (new TextEncoder().encode(body).length > LIMITS.textPlaintextBytes) {
      store?.setNotice(`单条消息超过 ${formatBytes(LIMITS.textPlaintextBytes)} 上限，请拆分后发送。`);
      return;
    }
    setDraft('');
    // Sending is the reader's own action, so the list follows it unconditionally — unlike an
    // inbound message, which only pins when they were already near the bottom.
    virt.scrollToBottom();
    try {
      await client.sendText(body);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setDraft(body);
      if (e?.code === 'CRYPTO_UNAVAILABLE') store?.setBlocked('随机数不可用，已阻止发送敏感内容。');
      else store?.setNotice(e?.message === 'not connected' ? '连接已断开，正在自动重连…' : '发送失败，可在消息上重试。');
    }
  };

  const loadOlder = useCallback(async () => {
    const client = sess?.client;
    if (!client || busyLoad.current || !snap.hasMore) return;
    busyLoad.current = true;
    sess.store.beginLoadOlder();
    virt.captureAnchor();
    try {
      const page = await client.loadOlder();
      if (page.count === 0) sess.store.markOlderEmpty();
      virt.onContentGrowth();
    } catch {
      sess.store.endLoadOlder();
      sess.store.setNotice('历史消息加载失败，请重试。');
    } finally {
      busyLoad.current = false;
    }
  }, [sess, snap.hasMore, virt]);

  // A peer's message frame carries only the attachment id; the encrypted metadata has to be pulled
  // by id. The store had this path (`metaFor`) and nothing ever called it, so an image stayed a
  // "loading" box for everyone but the uploader.
  useEffect(() => {
    if (!sess) return;
    for (const m of snap.messages) {
      if (m.kind === 'text' || !m.attachmentId || snap.metas[m.attachmentId]) continue;
      sess.store.metaFor(m.attachmentId);
    }
  }, [sess, snap.messages, snap.metas]);

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < 160) void loadOlder();
  };

  const doCopy = async (what: string, text: string) => {
    if (await copyText(text)) setCopied(what);
  };

  const enableNotify = async () => {
    const p = await requestPermission();
    setNotifyPerm(p);
    setNotifyOptIn(p === 'granted');
    if (p !== 'granted') sess?.store.setNotice('未开启通知，聊天不受影响。');
  };

  const destroyRoom = async () => {
    const client = sess?.client;
    if (!client) return;
    setShowDestroy(false);
    try {
      await client.destroy();
    } catch {
      sess?.store.setNotice('销毁请求失败，请重试。');
      return;
    }
    // A destroyed room has nothing left to show, not even a "destroyed" banner worth staying on.
    client.close();
    window.location.assign('/');
  };

  const leaveRoom = () => {
    sess?.client.close();
    window.location.assign('/');
  };

  // ------------------------------------------------------------------- render
  if (fatal) {
    return (
      <div className="center-screen">
        <WarnIcon />
        <h1>{fatal.title}</h1>
        <p>{fatal.body}</p>
        <a className="pill ghost" href="/">
          返回首页
        </a>
      </div>
    );
  }

  const client = sess?.client ?? null;
  const invite = client ? credentialsFromClient(client) : null;
  const link = client?.publicInvite.link ?? '';
  const code = client?.publicInvite.code ?? '';
  const canSend = !!client && snap.status === 'open' && !blocked;
  // Paging needs the whole ordered list, and that list has to stop changing once the viewer is
  // open: a message arriving mid-read would shift every index under the slide being looked at.
  openImageRef.current = (id: string) => {
    const ids = snap.messages
      .map((m) => (m.kind === 'image' ? m.attachmentId : undefined))
      .filter((x): x is string => !!x && !!snap.metas[x] && !snap.metaGaps.includes(x));
    const index = ids.indexOf(id);
    if (index < 0) return;
    setViewer({ ids, index });
  };
  const tip = (
    <SecurityLock
      secure={secure}
      open={tipOpen}
      onToggle={() => setTipOpen((v) => !v)}
      onClose={() => setTipOpen(false)}
      engine={client?.capability.engine ?? 'noble-js'}
      blocked={blocked}
      copy={securityCopy(secure)}
    />
  );

  return (
    <div className="room">
      <header className="room-head">
        {tip}
        <span className="room-id mono truncate">{client?.publicInvite.roomId ?? '…'}</span>
        <span className="online">{snap.online} 在线</span>
        <span className="spacer" />
        <span className={snap.status === 'open' ? 'status' : 'status bad'}>
          {snap.status === 'open' ? '' : snap.status === 'connecting' ? '连接中' : '已断开，重连中'}
        </span>
        <button type="button" className="icon-btn" aria-label="成员列表" onClick={() => setShowMembers(true)}>
          <Avatar nick={snap.members[0]?.nick ?? NICK_FALLBACK} small />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="浏览器通知"
          onClick={() => void enableNotify()}
          data-perm={notifyPerm}
        >
          <BellIcon />
        </button>
        <button type="button" className="pill ghost" onClick={() => setShowInvite(true)}>
          邀请
        </button>
        {client?.isCreator ? (
          <button type="button" className="pill danger" onClick={() => setShowDestroy(true)}>
            销毁
          </button>
        ) : null}
        <button type="button" className="pill ghost" onClick={leaveRoom}>
          离开
        </button>
      </header>

      {blocked ? (
        <div className="sec-blocked">
          <WarnIcon />
          <span className="truncate">{blocked}</span>
        </div>
      ) : null}
      {snap.notice ? <div className="notice-warn notice-bar">{snap.notice}</div> : null}

      <div className="list-wrap">
        <div className="list" ref={virt.setScrollElement} onScroll={onListScroll}>
          <div className="sizer" style={{ height: virt.totalHeight }}>
            {snap.messages.slice(virt.start, virt.end).map((m, i) => {
              const index = virt.start + i;
              return (
                <div className="row" key={m.id} style={{ transform: `translateY(${virt.offsetOf(index)}px)` }} ref={virt.measure(m.id)}>
                  <MessageRow
                    msg={m}
                    client={client}
                    meta={m.attachmentId ? snap.metas[m.attachmentId] : undefined}
                    metaGap={!!m.attachmentId && snap.metaGaps.includes(m.attachmentId)}
                    attachmentId={m.attachmentId}
                    uploads={snap.uploads}
                    onCopy={doCopy}
                    onRetry={(id) => void client?.retry(id)}
                    onAuthFail={reportAuthFailure}
                    onOpenImage={openImage}
                  />
                </div>
              );
            })}
          </div>
          {snap.loadingOlder ? <div className="loading-older">加载更早的消息…</div> : null}
        </div>
        {!virt.nearBottom && snap.messages.length > 0 ? (
          <button type="button" className="jump-bottom" onClick={virt.scrollToBottom}>
            回到底部
          </button>
        ) : null}
      </div>

      {jobs.length > 0 ? (
        <div className="queue">
          {jobs.map((j) => (
            <span className="pill ghost" key={j.key}>
              {j.state === 'failed' ? '失败' : j.state === 'queued' ? '排队中' : '上传中'} {j.name}{' '}
              {j.total > 0 ? `${Math.min(j.sent, j.total)}/${j.total}` : ''}
              {j.state === 'failed' ? (
                <button
                  type="button"
                  className="retry"
                  onClick={() => setJobs((prev) => prev.map((x) => (x.key === j.key ? { ...x, state: 'queued', sent: 0, error: undefined } : x)))}
                >
                  重试
                </button>
              ) : (
                <button type="button" className="retry" onClick={() => setJobs((prev) => prev.filter((x) => x.key !== j.key))}>
                  取消
                </button>
              )}
            </span>
          ))}
        </div>
      ) : null}

      <div className="composer">
        <button type="button" className="icon-btn" aria-label="添加文件" onClick={() => fileInput.current?.click()}>
          <PaperclipIcon />
        </button>
        <input ref={fileInput} type="file" hidden multiple onChange={(e) => { enqueue(e.target.files); e.target.value = ''; }} />
        <div className="input-field">
          <textarea
            ref={composerRef}
            value={draft}
            rows={1}
            placeholder={blocked ? '加密校验失败，已停止发送' : '输入消息，Enter 发送，Shift + Enter 换行'}
            aria-label="消息输入框"
            disabled={!canSend}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
        </div>
        <button type="button" className="send" onClick={() => void send()} disabled={!canSend || !draft.trim()}>
          发送
        </button>
      </div>

      {viewer && client ? (
        <PreviewHost
          client={client}
          ids={viewer.ids}
          index={viewer.index}
          metaOf={(id) => snap.metas[id]}
          onAuthFail={reportAuthFailure}
          onClose={() => setViewer(null)}
        />
      ) : null}

      {showInvite && invite ? (
        <Modal title="邀请别人加入" onClose={() => setShowInvite(false)}>
          <span className="label">任何拿到完整链接的人都能加入并解密，请按不记名凭证保管。</span>
          <div className="value-box">
            <div className="share-row">
              <span className="v truncate">{link}</span>
              <button type="button" className="copy" onClick={() => void doCopy('link', link)}>
                {copied === 'link' ? '已复制' : '复制链接'}
              </button>
            </div>
            <div className="share-row">
              <span className="v accent truncate">{code}</span>
              <button type="button" className="copy" onClick={() => void doCopy('code', code)}>
                {copied === 'code' ? '已复制' : '复制口令'}
              </button>
            </div>
          </div>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void navigator.share?.({ title: 'PoofSpace 聊天室', url: link }).catch(() => undefined)}
            >
              分享
            </button>
          ) : null}
          <span className="cap">链接中 # 之后的秘密只在浏览器本地使用，不会发送给服务器，也不会出现在服务器日志里。</span>
        </Modal>
      ) : null}

      {showMembers ? (
        <Modal title={`在线成员 ${snap.online}`} onClose={() => setShowMembers(false)}>
          <div className="list-plain">
            {snap.members.map((m) => (
              <div className="vault-item" key={m.slot}>
                <Avatar nick={m.nick} small />
                <div className="col">
                  <span className="rid truncate">{m.nick}</span>
                  <span className="when">{m.online ? '在线' : '离开'}{m.isCreator ? ' · 创建者' : ''}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="row2">
            <button type="button" className="btn btn-ghost" onClick={() => setShowNick(true)}>
              修改我的昵称
            </button>
          </div>
        </Modal>
      ) : null}

      {showNick ? (
        <NicknameDialog
          nick={nickState.nick}
          onClose={() => setShowNick(false)}
          onApply={(next) => {
            nickState.apply(next);
            sess?.client.setNickname(next);
          }}
        />
      ) : null}

      {/* Opening a link is accepting a name in the room; with no confirmed name there is nothing to join with. */}
      {!nickState.confirmed && !showNick ? (
        <NicknameDialog
          first
          nick=""
          onClose={() => {
            // The dialog closes itself after a successful confirm. Navigating away at that moment
            // throws the reader out of the room they just named, so only a real refusal leaves.
            if (acceptedRef.current) return;
            window.location.assign('/');
          }}
          onApply={(next) => {
            acceptedRef.current = true;
            nickState.apply(next);
          }}
        />
      ) : null}

      {showDestroy ? (
        <DestroyDialog onClose={() => setShowDestroy(false)} onConfirm={() => void destroyRoom()} />
      ) : null}
    </div>
  );
}

function SecurityLock({
  secure,
  open,
  onToggle,
  onClose,
  engine,
  blocked,
  copy
}: {
  secure: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  engine: string;
  blocked: string | null;
  copy: string;
}) {
  return (
    <div className={open ? 'sec open' : 'sec'} onMouseLeave={onClose}>
      <button
        type="button"
        className="sec-btn"
        aria-label="加密状态"
        aria-expanded={open}
        onClick={onToggle}
        onBlur={onClose}
      >
        {blocked ? <WarnIcon /> : <LockIcon />}
      </button>
      <div className="sec-tip" role="tooltip">
        <span className={blocked ? 'lbl bad' : 'lbl ok'}>
          {blocked ? `加密校验失败 · 已阻止发送` : `应用层端到端加密已启用 · ${engine}`}
        </span>
        <p>{copy}</p>
        {blocked ? <p className="notice-error">{blocked}</p> : null}
      </div>
    </div>
  );
}

function DestroyDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <Modal title="销毁聊天室" onClose={onClose}>
      <span className="label">销毁会删除服务端保存的全部密文历史与附件分片，并结束所有连接。</span>
      <span className="notice-warn">无法绝对清除对方已经截图、复制或下载的内容，销毁只保证受控存储被清理且访问立即失效。</span>
      <label className="ack">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>我已确认：房间销毁后不能恢复，旧链接与旧邀请码都会立即失效。</span>
      </label>
      <div className="row2">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-danger" disabled={!ack} onClick={onConfirm}>
          确认销毁
        </button>
      </div>
    </Modal>
  );
}

function MessageRow({
  msg,
  client,
  meta,
  metaGap,
  attachmentId,
  uploads,
  onCopy,
  onRetry,
  onAuthFail,
  onOpenImage
}: {
  msg: UiMsg;
  client: RoomClient | null;
  meta: AttachmentMeta | undefined;
  metaGap: boolean;
  attachmentId: string | undefined;
  uploads: RoomSnapshot['uploads'];
  onCopy: (key: string, text: string) => void;
  onRetry: (clientMsgId: string) => void;
  onAuthFail: () => void;
  onOpenImage: (attachmentId: string) => void;
}) {
  const [full, setFull] = useState(false);
  const long = isLongText(msg.text);
  // The bubble keeps its excerpt while the dialog is open: expanding inline as well changed the
  // row's height under the reader, which re-windowed the list, unmounted the row - and took the
  // dialog with it, because the dialog is rendered by this row.
  const body = long ? excerpt(msg.text) : msg.text;
  const bodyRef = useRef<HTMLParagraphElement | null>(null);

  // A selection inside this bubble is what the reader marked, so it wins; with no selection
  // (or one that reaches outside this row) the button copies the whole message.
  const copyTarget = (): string => {
    const sel = typeof window === 'undefined' ? null : window.getSelection();
    const chosen = sel?.toString() ?? '';
    const node = bodyRef.current;
    if (!chosen || !node || !sel) return msg.text;
    const start = sel.anchorNode;
    const end = sel.focusNode;
    const inside =
      (!!start && node.contains(start)) && (!!end && node.contains(end));
    return inside ? chosen : msg.text;
  };

  return (
    <div className={msg.own ? 'msg own' : 'msg'}>
      {msg.own ? null : <Avatar nick={msg.senderNick || NICK_FALLBACK} small />}
      <div className="col">
        {msg.own ? null : <span className="author truncate">{msg.senderNick || NICK_FALLBACK}</span>}
        <div className={msg.kind === 'image' ? 'bubble bubble-image' : 'bubble'}>
          {msg.kind === 'text' ? (
            <>
              <p className="text-block" ref={bodyRef}>{body}</p>
              {long ? (
                <button type="button" className="expand" onClick={() => setFull(!full)}>
                  {full ? '收起' : '展开全文'}
                </button>
              ) : null}
            </>
          ) : null}
          {msg.kind === 'image' && client && attachmentId && !metaGap ? (
            <ImageBody client={client} id={attachmentId} meta={meta} onAuthFail={onAuthFail} onOpen={onOpenImage} uploading={progress(msg, uploads)} />
          ) : null}
          {msg.kind === 'file' && client && attachmentId && !metaGap ? (
            <FileBody client={client} id={attachmentId} meta={meta} onAuthFail={onAuthFail} uploading={progress(msg, uploads)} />
          ) : null}
          {msg.kind !== 'text' && metaGap ? (
            <span className="thumb-placeholder">附件元数据已不可取（房间清理或请求被拒）</span>
          ) : null}
          {msg.kind !== 'text' && !attachmentId ? (
            <span className="thumb-placeholder">这条消息没有可取的附件</span>
          ) : null}
        </div>
        <div className="tail">
          <span className="time">{formatTime(msg.at)}</span>
          {msg.state === 'sending' ? <span className="state-sending">发送中</span> : null}
          {msg.state === 'failed' ? <span className="state-failed">发送失败{msg.error ? ` · ${msg.error}` : ''}</span> : null}
          {msg.state === 'failed' && msg.own ? (
            <button type="button" className="retry" onClick={() => onRetry(msg.id)}>
              重试
            </button>
          ) : null}
          {msg.kind === 'text' ? (
            <button type="button" className="retry copy-msg" onClick={() => onCopy(msg.id, copyTarget())}>
              复制
            </button>
          ) : null}
        </div>
      </div>
      {full ? (
        <Modal title="完整消息" wide onClose={() => setFull(false)}>
          {/* The text scrolls inside its own region: when a long message pushed the whole dialog,
              the two buttons ended up below the fold and the reader had to hunt for 关闭. */}
          <div className="scroll-box">
            <p className="full-text">{msg.text}</p>
          </div>
          <div className="row2">
            <button type="button" className="btn btn-ghost" onClick={() => setFull(false)}>
              关闭
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onCopy(`${msg.id}-full`, msg.text)}>
              全选并复制
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function progress(msg: UiMsg, uploads: RoomSnapshot['uploads']): string | null {
  if (msg.state !== 'sending' || !msg.attachmentId) return null;
  const u = uploads[msg.attachmentId];
  if (!u || u.total <= 0) return '加密中…';
  return `上传 ${Math.floor((u.sent / u.total) * 100)}%`;
}

function ImageBody({
  client,
  id,
  meta,
  onAuthFail,
  onOpen,
  uploading
}: {
  client: RoomClient;
  id: string;
  meta: AttachmentMeta | undefined;
  onAuthFail: () => void;
  onOpen: (attachmentId: string) => void;
  uploading: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    if (!meta) return;
    retain(id);
    let alive = true;
    thumbnailUrl(client, id, meta)
      .then((u) => {
        if (!alive) return;
        if (!u) setRefused(true);
        else setUrl(u);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setRefused(true);
        if (err instanceof DecryptError) onAuthFail();
      });
    return () => {
      alive = false;
      release(id);
    };
  }, [client, id, meta, onAuthFail]);

  if (uploading) return <span className="thumb-placeholder">{uploading}</span>;
  if (refused) return <span className="thumb-placeholder">密文认证失败，已拒绝渲染</span>;
  if (!meta) return <span className="thumb-placeholder">准备加载…</span>;
  if (!url) return <span className="thumb-placeholder">缩略图生成中…</span>;
  // The row hands over the id and nothing else: decrypting the full image, holding it while the
  // reader pages, and releasing it on close all belong to the viewer above the list, not to a row
  // that can be unmounted by scrolling while its image is still on screen.
  return <img className="thumb" src={url} alt="" loading="lazy" decoding="async" onClick={() => onOpen(id)} />;
}

function FileBody({
  client,
  id,
  meta,
  onAuthFail,
  uploading
}: {
  client: RoomClient;
  id: string;
  meta: AttachmentMeta | undefined;
  onAuthFail: () => void;
  uploading: string | null;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = meta?.name ?? '加密文件';
  return (
    <div className="file">
      <FileIcon />
      <div className="meta">
        <span className="name truncate">{name}</span>
        <span className="when mute">{meta ? formatBytes(meta.size) : '元数据解密中…'}</span>
        {uploading ? (
          <>
            <div className="bar">
              <div className="bar-fill" style={{ width: '60%' }} />
            </div>
            <span className="when">{uploading}</span>
          </>
        ) : null}
        {error ? <span className="notice-error">{error}</span> : null}
      </div>
      {meta && !uploading ? (
        <button
          type="button"
          className="copy"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            saveFile(client, id, meta)
              .catch((err: unknown) => {
                if (err instanceof DecryptError) {
                  setError('密文认证失败，文件已被拒绝下载。');
                  onAuthFail();
                } else {
                  setError('下载失败，请稍后重试。');
                }
              })
              .finally(() => setSaving(false));
          }}
        >
          {saving ? '解密中' : <DownloadIcon />}
          {saving ? '' : '下载'}
        </button>
      ) : null}
    </div>
  );
}

function isLongText(text: string): boolean {
  if (text.length > EXCERPT_CHARS) return true;
  let n = 0;
  for (const ch of text) if (ch === '\n') n++;
  return n >= EXCERPT_LINES;
}

function excerpt(text: string): string {
  const byLines = text.split('\n');
  if (byLines.length > EXCERPT_LINES) return `${byLines.slice(0, EXCERPT_LINES).join('\n')}\n…`;
  if (text.length > EXCERPT_CHARS) return `${text.slice(0, EXCERPT_CHARS)}…`;
  return text;
}
