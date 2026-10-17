'use client';

import { useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import type { RoomClient } from '@/lib/client/roomclient';

const H = 3_600_000;

/**
 * The tiers, with their labels, written out. The hours are also in `IDLE_DELAY_CHOICES_MS`, but a
 * dialog that derived its own expected text from that constant would keep agreeing with itself after
 * somebody changed the list -- so the number the reader sees and the number sent are stated here
 * once, and the browser leg names these strings literally.
 */
const TIERS: { ms: number; label: string }[] = [
  { ms: 4 * H, label: '4 小时' },
  { ms: 8 * H, label: '8 小时' },
  { ms: 12 * H, label: '12 小时' },
  { ms: 24 * H, label: '24 小时' },
  { ms: 36 * H, label: '36 小时' },
  { ms: 72 * H, label: '72 小时' }
];

function describe(ms: number | null): string {
  if (ms === null) return '未设置（沿用本节点默认 5 分钟）';
  const hit = TIERS.find((t) => t.ms === ms);
  return hit ? `当前：${hit.label}` : '当前：一个不在档位表里的值';
}

/**
 * Arming a longer recovery window, for the room's owner only. The window is consumed the first time
 * the room empties and the countdown is cancelled by anyone returning, so this is a one-shot
 * promise about the next absence, not a permanent setting -- which is what the copy says.
 */
export default function DelayDialog({ client, onClose }: { client: RoomClient; onClose: () => void }) {
  const [current, setCurrent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    client
      .getIdleDelay()
      .then((ms) => {
        if (alive) setCurrent(ms);
      })
      .catch(() => {
        if (alive) setNote('读取失败，房间可能已结束');
      });
    return () => {
      alive = false;
    };
  }, [client]);

  const choose = async (ms: number | null, label: string) => {
    setBusy(true);
    setNote('');
    try {
      await client.setIdleDelay(ms);
      setCurrent(ms);
      setNote(ms === null ? '已取消延时' : `已设为 ${label}，下一次无人时生效`);
    } catch {
      setNote('服务器拒绝了这次设置');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="延长销毁倒计时" onClose={onClose}>
      <span className="label">只有你（房主）能设置。房间空下来之后才开始计时，任何人在倒计时里回来都会取消它，并且这次设置就用掉了。</span>
      <span className="cap" data-delay="current">{describe(current)}</span>
      <div className="delay-grid">
        {TIERS.map((t) => (
          <button
            key={t.ms}
            type="button"
            className={t.ms === current ? 'btn btn-ghost delay-tier is-current' : 'btn btn-ghost delay-tier'}
            aria-pressed={t.ms === current}
            data-delay-tier={String(t.ms / H)}
            disabled={busy}
            onClick={() => void choose(t.ms, t.label)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-ghost" data-delay="clear" disabled={busy} onClick={() => void choose(null, '')}>
        取消延时
      </button>
      {note ? <span className="cap" data-delay="note">{note}</span> : null}
      <div className="row2">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
