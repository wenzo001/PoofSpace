'use client';

import { useEffect, useState } from 'react';
import Modal from './Modal';
import { generateNickname, normalizeNickname, LIMITS_NICK } from '@/lib/client/identity';
import { detectCrypto } from '@/lib/crypto/engine';

export default function NicknameDialog({
  nick,
  onClose,
  onApply
}: {
  nick: string;
  onClose: () => void;
  onApply: (next: string) => void;
}) {
  const [value, setValue] = useState(nick);
  // Rolling a suggestion needs a CSPRNG; without one the control could only ever fail.
  const canRoll = detectCrypto().csprng;

  useEffect(() => setValue(nick), [nick]);

  const save = () => {
    const next = normalizeNickname(value);
    onApply(next);
    onClose();
  };

  return (
    <Modal title="昵称" onClose={onClose}>
      <span className="label">昵称只在房间内显示，可随时修改。</span>
      <div className="field">
        <input
          value={value}
          maxLength={LIMITS_NICK}
          placeholder={nick}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          aria-label="昵称"
        />
        {canRoll ? (
          <button type="button" className="swap" onClick={() => setValue(generateNickname())}>
            换一个
          </button>
        ) : null}
      </div>
      <div className="row2">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={save}>
          保存
        </button>
      </div>
    </Modal>
  );
}
