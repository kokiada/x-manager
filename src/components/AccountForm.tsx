import { useState, type FormEvent } from 'react';
import type { Account, EmailAddress, Group, NewAccount, ProxyGroup } from '../db/types';
import { ACCOUNT_STATUSES, STATUS_LABELS } from '../db/types';
import { maskToken } from '../lib/format';
import { Button, Tooltip } from './ui';

interface Props {
  initial?: Account;
  groups: Group[];
  proxyGroups: ProxyGroup[];
  /** Mail ledger entries to choose from (may be empty). */
  emails?: EmailAddress[];
  onSubmit: (input: NewAccount) => Promise<void>;
  onCancel: () => void;
}

/**
 * Add / edit form for one account. The auth token is write-only in
 * the UI: an existing token is shown masked and left untouched unless
 * a new value is typed.
 */
export function AccountForm({ initial, groups, proxyGroups, emails = [], onSubmit, onCancel }: Props) {
  const [handle, setHandle] = useState(initial?.handle ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [groupId, setGroupId] = useState<string>(initial?.groupId ?? '');
  const [proxyGroupId, setProxyGroupId] = useState<string>(initial?.proxyGroupId ?? '');
  const [emailId, setEmailId] = useState<string>(initial?.emailId ?? '');
  const [status, setStatus] = useState(initial?.status ?? 'logged_out');
  const [authToken, setAuthToken] = useState('');
  const [memo, setMemo] = useState(initial?.memo ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanHandle = handle.trim().replace(/^@/, '');
    if (!cleanHandle) {
      setError('XのID（@ハンドル）を入力してください。');
      return;
    }
    if (!displayName.trim()) {
      setError('表示名を入力してください。');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        handle: cleanHandle,
        displayName: displayName.trim(),
        groupId: groupId || null,
        proxyGroupId: proxyGroupId || null,
        emailId: emailId || null,
        status,
        authToken: authToken.trim() ? authToken.trim() : initial?.authToken,
        followers: initial?.followers ?? 0,
        following: initial?.following ?? 0,
        notifications: initial?.notifications ?? 0,
        dmCount: initial?.dmCount ?? 0,
        searchBan: initial?.searchBan ?? 'unknown',
        memo: memo.trim() || undefined,
        lastCheckedAt: initial?.lastCheckedAt,
      });
    } catch {
      setError('保存に失敗しました。もう一度お試しください。');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="af-handle">X ID（ハンドル）</label>
          <input
            id="af-handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="example_user"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="af-name">表示名</label>
          <input
            id="af-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="運用名"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="af-group">グループ</label>
          <select id="af-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">（未分類）</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="af-proxy">プロキシグループ</label>
          <select
            id="af-proxy"
            value={proxyGroupId}
            onChange={(e) => setProxyGroupId(e.target.value)}
          >
            <option value="">直接接続（なし）</option>
            {proxyGroups.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="af-email">メールアドレス</label>
        <select id="af-email" value={emailId} onChange={(e) => setEmailId(e.target.value)}>
          <option value="">（未設定）</option>
          {emails.map((e) => (
            <option key={e.id} value={e.id}>
              {e.address}
              {e.label ? `（${e.label}）` : ''}
            </option>
          ))}
        </select>
        <div className="hint">
          メールアドレス台帳で追加したものから選べます。
        </div>
      </div>

      <div className="field">
        <label htmlFor="af-status">ステータス</label>
        <select
          id="af-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as Account['status'])}
        >
          {ACCOUNT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="af-token">
          auth_token（トークンログイン用）{' '}
          <Tooltip label="端末内にのみ保存され、画面には常にマスク表示されます。">
            <span aria-hidden="true">？</span>
          </Tooltip>
        </label>
        <input
          id="af-token"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder={initial?.authToken ? `登録済み: ${maskToken(initial.authToken)}` : '40文字のトークン'}
          autoComplete="off"
          spellCheck={false}
        />
        {initial?.authToken && (
          <div className="hint">
            空欄のまま保存すると現在のトークンを保持します。
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="af-memo">メモ</label>
        <textarea
          id="af-memo"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          rows={2}
          placeholder="運用メモ"
        />
      </div>

      {error && <p style={{ color: 'var(--c-bad)', fontWeight: 700 }}>{error}</p>}

      <div className="modal-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? '保存中…' : initial ? '変更を保存' : 'アカウントを追加'}
        </Button>
      </div>
    </form>
  );
}
