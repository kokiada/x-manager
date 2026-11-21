import { useMemo, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { EmailAddress, EmailProvider, NewEmailAddress } from '../db/types';
import { EMAIL_PROVIDERS, EMAIL_PROVIDER_LABELS } from '../db/types';
import {
  createEmailAddress,
  deleteEmailAddress,
  updateEmailAddress,
} from '../db/repository';
import { checkEmailLinks } from '../lib/emailLinkCheck';
import { Button, Modal, useToast } from '../components/ui';

type ModalState =
  | { kind: 'none' }
  | { kind: 'add' }
  | { kind: 'edit'; email: EmailAddress };

function EmailForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: EmailAddress;
  onSubmit: (input: NewEmailAddress) => Promise<void>;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState(initial?.address ?? '');
  const [provider, setProvider] = useState<EmailProvider>(initial?.provider ?? 'gmail');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setError('メールアドレスの形式で入力してください。');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        address: clean,
        provider,
        label: label.trim() || undefined,
      });
    } catch {
      setError('保存に失敗しました。もう一度お試しください。');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor="em-address">メールアドレス</label>
        <input
          id="em-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="example@gmail.com"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label htmlFor="em-provider">プロバイダ</label>
        <select
          id="em-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as EmailProvider)}
        >
          {EMAIL_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {EMAIL_PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
        <div className="hint">
          受信チェックは Gmail / Outlook を優先対応します（設計は docs/EMAIL_DESIGN.md）。
        </div>
      </div>
      <div className="field">
        <label htmlFor="em-label">ラベル / メモ</label>
        <input
          id="em-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="メイン運用"
          autoComplete="off"
        />
      </div>
      {error && <p style={{ color: 'var(--c-bad)', fontWeight: 700 }}>{error}</p>}
      <div className="modal-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          キャンセル
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? '保存中…' : initial ? '変更を保存' : 'メールアドレスを追加'}
        </Button>
      </div>
    </form>
  );
}

export function Emails() {
  const toast = useToast();
  const emails = useLiveQuery(() => db.emailAddresses.toArray(), [], undefined);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });

  const check = useMemo(
    () => checkEmailLinks(accounts ?? [], emails ?? []),
    [accounts, emails],
  );
  const accountsByEmail = useMemo(() => {
    const map = new Map<string, { handle: string; displayName: string }[]>();
    for (const a of accounts ?? []) {
      if (!a.emailId) continue;
      const list = map.get(a.emailId) ?? [];
      list.push({ handle: a.handle, displayName: a.displayName });
      map.set(a.emailId, list);
    }
    return map;
  }, [accounts]);

  const submitForm = async (input: NewEmailAddress) => {
    if (modal.kind === 'edit') {
      await updateEmailAddress(modal.email.id, input);
      toast.push(`${input.address} を更新しました`, 'ok');
    } else {
      await createEmailAddress(input);
      toast.push(`${input.address} を追加しました`, 'ok');
    }
    setModal({ kind: 'none' });
  };

  const handleDelete = async (email: EmailAddress) => {
    const users = accountsByEmail.get(email.id) ?? [];
    if (
      !window.confirm(
        `${email.address} を削除しますか？` +
          (users.length > 0
            ? `\n${users.length}件のアカウントとの紐づけが外れます（アカウント自体は消えません）。`
            : '\nこのアドレスを使うアカウントはありません。'),
      )
    ) {
      return;
    }
    await deleteEmailAddress(email.id);
    toast.push(
      users.length > 0
        ? `${email.address} を削除し、${users.length}件のアカウントの紐づけを外しました`
        : `${email.address} を削除しました`,
      'ok',
    );
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">11</span>メールアドレス
          </h1>
          <p className="page-lede">
            アカウントに紐づけるメールアドレスの台帳。削除してもアカウント自体は消えず、紐づけだけ外れます。
          </p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button variant="primary" onClick={() => setModal({ kind: 'add' })}>
            ＋ メールアドレス追加
          </Button>
        </div>
      </div>

      <h2 className="section-title">紐づけチェック</h2>
      <div className="detail-grid">
        <div className="detail-cell">
          <div className="k">メアド未設定のアカウント（{check.withoutEmail.length}件）</div>
          <div className="v" style={{ fontSize: 13 }}>
            {check.withoutEmail.length === 0
              ? 'なし'
              : check.withoutEmail.map((a) => `@${a.handle}`).join('、')}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">使い回し中のメアド（{check.shared.length}件）</div>
          <div className="v" style={{ fontSize: 13 }}>
            {check.shared.length === 0
              ? 'なし'
              : check.shared.map(
                  (s) => `${s.email.address}（${s.accounts.map((a) => `@${a.handle}`).join('、')}）`,
                ).join(' ／ ')}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">未使用のメアド（{check.unused.length}件）</div>
          <div className="v" style={{ fontSize: 13 }}>
            {check.unused.length === 0
              ? 'なし'
              : check.unused.map((e) => e.address).join('、')}
          </div>
        </div>
      </div>

      <h2 className="section-title">メールアドレス一覧</h2>
      {emails === undefined && <p className="faded">読み込み中…</p>}
      {emails !== undefined && emails.length === 0 && (
        <p className="faded">
          メールアドレスがまだ登録されていません。「メールアドレス追加」から登録してください。
        </p>
      )}
      {(emails ?? []).map((e) => {
        const users = accountsByEmail.get(e.id) ?? [];
        return (
          <div key={e.id} className="simple-row">
            <span className="grow">
              <span className="mono" style={{ fontSize: 13.5, fontWeight: 700 }}>{e.address}</span>
              {e.label && (
                <span className="faded" style={{ fontSize: 12.5 }}> — {e.label}</span>
              )}
              <br />
              <span className="faded" style={{ fontSize: 12.5 }}>
                {users.length === 0
                  ? '未使用'
                  : `使うアカウント: ${users.map((u) => `@${u.handle}`).join('、')}`}
              </span>
            </span>
            <span className="badge plain">{EMAIL_PROVIDER_LABELS[e.provider]}</span>
            <span>
              <Button small variant="ghost" onClick={() => setModal({ kind: 'edit', email: e })}>
                編集
              </Button>{' '}
              <Button small variant="danger" onClick={() => void handleDelete(e)}>
                削除
              </Button>
            </span>
          </div>
        );
      })}

      <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
        受信メールのチェックはまだ未実装です。設計は docs/EMAIL_DESIGN.md を参照してください。
      </p>

      {modal.kind === 'add' && (
        <Modal title="メールアドレス追加" onClose={() => setModal({ kind: 'none' })}>
          <EmailForm onSubmit={submitForm} onCancel={() => setModal({ kind: 'none' })} />
        </Modal>
      )}
      {modal.kind === 'edit' && (
        <Modal title="メールアドレス編集" onClose={() => setModal({ kind: 'none' })}>
          <EmailForm
            initial={modal.email}
            onSubmit={submitForm}
            onCancel={() => setModal({ kind: 'none' })}
          />
        </Modal>
      )}
    </div>
  );
}
