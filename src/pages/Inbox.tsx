import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { markAllNotificationsRead, markNotificationRead } from '../db/repository';
import { refreshNotifications } from '../lib/notificationService';
import { checkedAtLabel, fullCount } from '../lib/format';
import { Button, useToast } from '../components/ui';

export function Inbox() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const items = useLiveQuery(() => db.notifications.orderBy('at').reverse().limit(200).toArray(), [], []);

  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'notification' | 'dm'>('all');
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const totalNotifications = (accounts ?? []).reduce((s, a) => s + a.notifications, 0);
  const totalDm = (accounts ?? []).reduce((s, a) => s + a.dmCount, 0);
  const unread = (items ?? []).filter((n) => !n.read).length;

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (n) =>
          (accountFilter === 'all' || n.accountId === accountFilter) &&
          (kindFilter === 'all' || n.kind === kindFilter),
      ),
    [items, accountFilter, kindFilter],
  );

  const refresh = async (accountId: string) => {
    const account = (accounts ?? []).find((a) => a.id === accountId);
    if (!account) return;
    setRefreshingId(accountId);
    try {
      const added = await refreshNotifications(account);
      toast.push(
        added > 0
          ? `@${account.handle} の通知を更新しました（${added}件の新規）`
          : `@${account.handle} に新しい通知はありませんでした`,
        'ok',
      );
    } catch {
      toast.push('通知の更新に失敗しました', 'err');
    } finally {
      setRefreshingId(null);
    }
  };

  if (!accounts) return <p className="faded">読み込み中…</p>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">08</span>通知 / DM
          </h1>
          <p className="page-lede">
            全アカウントの通知とDMを集約します（§11）。件数はアカウントチェックで取得され、本文は
            アカウントごとの「通知を更新」で取り込みます。
          </p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button
            onClick={() => {
              void markAllNotificationsRead(accountFilter === 'all' ? undefined : accountFilter);
              toast.push('すべて既読にしました', 'ok');
            }}
            disabled={(items ?? []).length === 0}
          >
            すべて既読にする
          </Button>
        </div>
      </div>

      <div className="kv-strip">
        <div className="kv-cell">
          <div className="kv-num">{fullCount(totalNotifications)}</div>
          <div className="kv-label">未対応の通知 合計（アカウントチェック時点）</div>
        </div>
        <div className="kv-cell">
          <div className="kv-num">{fullCount(totalDm)}</div>
          <div className="kv-label">未読DM 合計（アカウントチェック時点）</div>
        </div>
        <div className="kv-cell">
          <div className="kv-num">{fullCount(unread)}</div>
          <div className="kv-label">この画面で未読の項目</div>
        </div>
      </div>

      <h2 className="section-title">アカウント別</h2>
      <div className="ledger-simple">
        {accounts.map((a) => {
          const stored = (items ?? []).filter((n) => n.accountId === a.id);
          const storedUnread = stored.filter((n) => !n.read).length;
          return (
            <div key={a.id} className="simple-row">
              <span className="grow">
                <strong>{a.displayName}</strong>{' '}
                <span className="mono faded" style={{ fontSize: 12 }}>@{a.handle}</span>
                <div className="faded" style={{ fontSize: 12.5 }}>
                  通知 {a.notifications}件 / DM {a.dmCount}件
                  {stored.length > 0 && `（本文取得済み ${stored.length}件・未読 ${storedUnread}件）`}
                </div>
              </span>
              <Button small onClick={() => void refresh(a.id)} disabled={refreshingId === a.id || a.status !== 'logged_in'}>
                {refreshingId === a.id ? '更新中…' : '通知を更新'}
              </Button>
            </div>
          );
        })}
      </div>

      <h2 className="section-title">一覧</h2>
      <div className="toolbar">
        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} aria-label="アカウントで絞り込み">
          <option value="all">全アカウント</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.handle}
            </option>
          ))}
        </select>
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)} aria-label="種類で絞り込み">
          <option value="all">通知 + DM</option>
          <option value="notification">通知のみ</option>
          <option value="dm">DMのみ</option>
        </select>
        <span className="faded" style={{ fontSize: 12.5 }}>{filtered.length}件</span>
      </div>

      {filtered.length === 0 ? (
        <div className="placeholder-box">
          <div className="ph-tag">EMPTY</div>
          <p style={{ marginBottom: 0 }}>
            通知・DMの本文はまだ取り込まれていません。アカウント別の「通知を更新」ボタンで取り込めます。
            （件数はアカウントチェックで更新されます）
          </p>
        </div>
      ) : (
        <div className="ledger-simple">
          {filtered.map((n) => (
            <div key={n.id} className="simple-row" style={{ opacity: n.read ? 0.65 : 1 }}>
              <span className="badge plain">{n.kind === 'dm' ? 'DM' : '通知'}</span>
              <span className="grow">
                <strong>{n.title}</strong>{' '}
                <span className="mono faded" style={{ fontSize: 12 }}>
                  @{n.handle}
                  {n.fromHandle ? ` / from @${n.fromHandle}` : ''}
                </span>
                <div style={{ fontSize: 13.5 }}>{n.body}</div>
                <div className="faded mono" style={{ fontSize: 12 }}>{checkedAtLabel(n.at)}</div>
              </span>
              {!n.read && (
                <Button small variant="ghost" onClick={() => void markNotificationRead(n.id)}>
                  既読にする
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
        注意：通知・DMの本文集約の詳細はマニュアルに文書化されていません（§11）。この画面の本文は
        シミュレータが件数から生成したデモ表示です。実運用では Executor の実実装が本文を取得します。
      </p>
    </div>
  );
}
