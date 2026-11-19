import { useMemo, useState } from 'react';
import type { Account } from '../../db/types';
import { Button, StatusBadge } from '../ui';

/**
 * Target-account picker for bulk posting. Execution is strictly
 * top-to-bottom (research §6-1), so selection is an *ordered* list:
 * checking an account appends it, and the order can be changed with
 * drag & drop or the ↑/↓ buttons (mobile-friendly).
 */
export function AccountOrderPicker({
  accounts,
  value,
  onChange,
  disabled,
}: {
  accounts: Account[];
  /** Selected account IDs in execution order. */
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const selected = value.map((id) => byId.get(id)).filter((a): a is Account => !!a);
  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.handle.localeCompare(b.handle)),
    [accounts],
  );

  const toggle = (id: string, checked: boolean) => {
    if (checked) onChange([...value, id]);
    else onChange(value.filter((v) => v !== id));
  };

  const move = (id: string, delta: number) => {
    const idx = value.indexOf(id);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= value.length) return;
    const copy = [...value];
    [copy[idx], copy[next]] = [copy[next], copy[idx]];
    onChange(copy);
  };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const from = value.indexOf(dragId);
    const to = value.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const copy = [...value];
    copy.splice(from, 1);
    copy.splice(to, 0, dragId);
    onChange(copy);
    setDragId(null);
  };

  return (
    <div>
      <div className="pick-list" role="group" aria-label="アカウント選択">
        {sorted.map((a) => (
          <label key={a.id} className="pick-row">
            <input
              type="checkbox"
              checked={value.includes(a.id)}
              disabled={disabled}
              onChange={(e) => toggle(a.id, e.target.checked)}
            />
            <span className="pick-main">
              <strong>{a.displayName}</strong>{' '}
              <span className="mono faded" style={{ fontSize: 12 }}>
                @{a.handle}
              </span>
            </span>
            <StatusBadge status={a.status} />
          </label>
        ))}
        {sorted.length === 0 && <p className="faded">アカウントが登録されていません。</p>}
      </div>

      <h3 className="mini-title">
        投稿順（{selected.length}件・上から順に実行）
      </h3>
      {selected.length === 0 ? (
        <p className="faded" style={{ fontSize: 13 }}>
          上の一覧でチェックしたアカウントが、ここに投稿順で並びます。
        </p>
      ) : (
        <ol className="order-list">
          {selected.map((a, i) => (
            <li
              key={a.id}
              className={`order-row ${dragId === a.id ? 'dragging' : ''}`}
              draggable={!disabled}
              onDragStart={() => setDragId(a.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(a.id)}
            >
              <span className="order-no mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="pick-main">
                <strong>{a.displayName}</strong>{' '}
                <span className="mono faded" style={{ fontSize: 12 }}>
                  @{a.handle}
                </span>
                {a.status !== 'logged_in' && (
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    {' '}
                    ※実行時にスキップされます
                  </span>
                )}
              </span>
              <span className="order-btns">
                <Button small variant="ghost" disabled={disabled || i === 0} onClick={() => move(a.id, -1)} aria-label="上へ">
                  ↑
                </Button>
                <Button
                  small
                  variant="ghost"
                  disabled={disabled || i === selected.length - 1}
                  onClick={() => move(a.id, 1)}
                  aria-label="下へ"
                >
                  ↓
                </Button>
                <Button
                  small
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => toggle(a.id, false)}
                  aria-label="対象から外す"
                >
                  ✕
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <Button
          small
          disabled={disabled || sorted.length === 0}
          onClick={() => onChange(sorted.map((a) => a.id))}
        >
          全アカウントを選択
        </Button>
        <Button small variant="ghost" disabled={disabled || value.length === 0} onClick={() => onChange([])}>
          選択をクリア
        </Button>
      </div>
    </div>
  );
}
