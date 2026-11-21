import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/db';
import type { Account, NewAccount } from '../db/types';
import { createAccount, recordFollowerHistory, updateAccount } from '../db/repository';
import { executor } from '../executor';
import { accountsToCsv } from '../lib/accountCsv';
import { downloadTextFile } from '../lib/csv';
import { compactCount, checkedAtLabel } from '../lib/format';
import { AccountForm } from '../components/AccountForm';
import { GroupManager } from '../components/GroupManager';
import { Button, Modal, StatusBadge, useToast } from '../components/ui';
import { useLinkedAccounts } from '../hooks/useLinkedAccounts';
import { isLinkedAccount } from '../lib/extensionLink';

type ModalState =
  | { kind: 'none' }
  | { kind: 'add' }
  | { kind: 'edit'; account: Account }
  | { kind: 'groups' };

export function Accounts() {
  const toast = useToast();
  const navigate = useNavigate();

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const proxyGroups = useLiveQuery(() => db.proxyGroups.toArray(), [], []);

  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const { mode, linkedIds, refresh: refreshLinked } = useLinkedAccounts();
  const [refreshingLink, setRefreshingLink] = useState(false);

  const groupName = (id: string | null) =>
    id ? (groups?.find((g) => g.id === id)?.name ?? '—') : '未分類';
  const proxyName = (id: string | null) =>
    id ? (proxyGroups?.find((p) => p.id === id)?.name ?? '—') : '直接接続';

  const filtered = useMemo(() => {
    if (!accounts) return [];
    const q = query.trim().toLowerCase();
    return accounts
      .filter((a) => groupFilter === 'all' || a.groupId === groupFilter)
      .filter(
        (a) =>
          !q ||
          a.handle.toLowerCase().includes(q) ||
          a.displayName.toLowerCase().includes(q),
      )
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }, [accounts, groupFilter, query]);

  const runCheck = async (account: Account) => {
    setCheckingId(account.id);
    try {
      const result = await executor.checkAccount(account);
      await recordFollowerHistory(account.id, result.followers);
      toast.push(
        `@${account.handle} をチェックしました（フォロワー ${result.followers.toLocaleString('ja-JP')}）`,
        'ok',
      );
    } catch {
      toast.push(`@${account.handle} のチェックに失敗しました`, 'err');
    } finally {
      setCheckingId(null);
    }
  };

  const runBulkCheck = async () => {
    const targets = filtered;
    let done = 0;
    for (const account of targets) {
      setBulkProgress(`チェック中 ${done + 1}/${targets.length}: @${account.handle}`);
      try {
        const result = await executor.checkAccount(account);
        await recordFollowerHistory(account.id, result.followers);
      } catch {
        /* continue with the next account, as XBoard does */
      }
      done++;
    }
    setBulkProgress(null);
    toast.push(`${done}件のアカウントチェックが完了しました`, 'ok');
  };

  const submitForm = async (input: NewAccount) => {
    if (modal.kind === 'edit') {
      await updateAccount(modal.account.id, input);
      toast.push(`@${input.handle} を更新しました`, 'ok');
    } else {
      await createAccount({
        ...input,
        status: input.authToken ? 'logged_in' : input.status,
      });
      toast.push(`@${input.handle} を追加しました`, 'ok');
    }
    setModal({ kind: 'none' });
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">02</span>アカウント
          </h1>
          <p className="page-lede">
            アカウント台帳。状態・通知/DM件数・フォロワー数はアカウントチェックで更新されます。
          </p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button
            onClick={() => {
              if (!accounts || !groups || !proxyGroups) return;
              downloadTextFile('accounts.csv', accountsToCsv(accounts, groups, proxyGroups));
              toast.push('アカウントCSVを書き出しました', 'ok');
            }}
            disabled={!accounts || accounts.length === 0}
          >
            CSV書出
          </Button>
          <Button onClick={() => setModal({ kind: 'groups' })}>グループ管理</Button>
          <Button variant="primary" onClick={() => setModal({ kind: 'add' })}>
            ＋ アカウント追加
          </Button>
        </div>
      </div>

      <div className="toolbar">
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="グループで絞り込み"
        >
          <option value="all">全グループ</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="ID・表示名で検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="アカウント検索"
          style={{ flex: '1 1 180px' }}
        />
        <span className="spacer" />
        {mode === 'extension' && (
          <Button
            onClick={async () => {
              setRefreshingLink(true);
              try {
                await refreshLinked();
              } finally {
                setRefreshingLink(false);
              }
            }}
            disabled={refreshingLink}
          >
            {refreshingLink ? '確認中…' : '連携状態を更新'}
          </Button>
        )}
        {bulkProgress ? (
          <span className="progress-line">{bulkProgress}</span>
        ) : (
          <Button onClick={runBulkCheck} disabled={filtered.length === 0}>
            表示中を全件チェック
          </Button>
        )}
      </div>

      <div className="ledger" role="table" aria-label="アカウント一覧">
        <div className="ledger-head" role="row">
          <span />
          <span>アカウント</span>
          <span>指標（フォロワー / 通知 / DM）</span>
          <span>状態</span>
          <span>グループ / プロキシ</span>
          <span>最終チェック</span>
          <span>操作</span>
        </div>
        {accounts === undefined && <div className="ledger-empty">読み込み中…</div>}
        {accounts !== undefined && filtered.length === 0 && (
          <div className="ledger-empty">
            {accounts.length === 0
              ? 'アカウントがまだ登録されていません。「アカウント追加」から登録するか、データ管理からCSVで取り込んでください。'
              : '条件に合うアカウントがありません。検索条件を変えるか、アカウントを追加してください。'}
          </div>
        )}
        {filtered.map((a) => (
          <div
            key={a.id}
            className="ledger-row"
            role="row"
            onClick={() => navigate(`/accounts/${a.id}`)}
          >
            <span className={`ledger-rail rail-${a.status}`} />
            <span className="acct-main">
              <span className="acct-name">{a.displayName}</span>
              <br />
              <span className="acct-handle">@{a.handle}</span>
            </span>
            <span className="cell-nums acct-nums">
              <span>
                FW <b>{compactCount(a.followers)}</b>
              </span>
              <span className={a.notifications > 0 ? 'hot' : ''}>
                通知 <b>{a.notifications}</b>
              </span>
              <span className={a.dmCount > 0 ? 'hot' : ''}>
                DM <b>{a.dmCount}</b>
              </span>
            </span>
            <span className="cell-badge">
              <StatusBadge status={a.status} />
              {mode === 'extension' && linkedIds !== null && (
                <>
                  {' '}
                  {isLinkedAccount(linkedIds, a.id) ? (
                    <span className="badge linked">連携済み</span>
                  ) : (
                    <span className="badge plain">未連携</span>
                  )}
                </>
              )}
            </span>
            <span className="cell-meta faded" style={{ fontSize: 12.5 }}>
              {groupName(a.groupId)}
              <br />
              <span className="mono" style={{ fontSize: 11.5 }}>
                {a.proxyGroupId ? '◈ ' : '◇ '}
                {proxyName(a.proxyGroupId)}
              </span>
            </span>
            <span className="cell-meta mono faded" style={{ fontSize: 12 }}>
              {checkedAtLabel(a.lastCheckedAt)}
            </span>
            <span className="cell-actions" onClick={(e) => e.stopPropagation()}>
              <Button
                small
                onClick={() => runCheck(a)}
                disabled={checkingId === a.id || bulkProgress !== null}
              >
                {checkingId === a.id ? '確認中…' : 'チェック'}
              </Button>{' '}
              <Button small variant="ghost" onClick={() => setModal({ kind: 'edit', account: a })}>
                編集
              </Button>
            </span>
          </div>
        ))}
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
        行をクリックすると詳細が開きます。削除は詳細画面から行えます。チェックはシミュレータ
        Executor 経由で実行され、結果は台帳に反映されます。
      </p>

      {modal.kind === 'add' && (
        <Modal title="アカウント追加" onClose={() => setModal({ kind: 'none' })}>
          <AccountForm
            groups={groups ?? []}
            proxyGroups={proxyGroups ?? []}
            onSubmit={submitForm}
            onCancel={() => setModal({ kind: 'none' })}
          />
        </Modal>
      )}
      {modal.kind === 'edit' && (
        <Modal title="アカウント編集" onClose={() => setModal({ kind: 'none' })}>
          <AccountForm
            initial={modal.account}
            groups={groups ?? []}
            proxyGroups={proxyGroups ?? []}
            onSubmit={submitForm}
            onCancel={() => setModal({ kind: 'none' })}
          />
        </Modal>
      )}
      {modal.kind === 'groups' && (
        <Modal title="グループ管理" onClose={() => setModal({ kind: 'none' })}>
          <GroupManager onClose={() => setModal({ kind: 'none' })} />
        </Modal>
      )}
    </div>
  );
}
