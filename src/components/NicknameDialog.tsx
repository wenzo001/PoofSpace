'use client';

import { useEffect, useState } from 'react';
import Modal from './Modal';
import { generateNickname, normalizeNickname, LIMITS_NICK } from '@/lib/client/identity';
import { detectCrypto } from '@/lib/crypto/engine';

export default function NicknameDialog({
  nick,
  first = false,
  onClose,
  onApply
}: {
  nick: string;
  /** First run: the name on offer has never been confirmed, so nothing is cached until 确认. */
  first?: boolean;
  onClose: () => void;
  onApply: (next: string) => void;
}) {
  // Rolling a suggestion needs a CSPRNG; without one the control could only ever fail.
  const canRoll = detectCrypto().csprng;
  const [value, setValue] = useState(() => nick || (canRoll ? generateNickname() : '访客'));

  useEffect(() => {
    // An empty nick means "not confirmed yet": that is the suggestion's job, not a reset to blank.
    if (nick) setValue(nick);
  }, [nick]);

  const save = () => {
    const next = normalizeNickname(value);
    onApply(next);
    onClose();
  };

  return (
    <Modal title={first ? '确认昵称' : '昵称'} onClose={onClose}>
      <span className="label">
        {first
          ? '给你生成了一个名字，可以换一个；确认后只保存在这台设备上，之后除非你主动改，会一直用它。'
          : '昵称只在房间内显示，可随时修改。'}
      </span>
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
          {first ? '确认并进入' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
