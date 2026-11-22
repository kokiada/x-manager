import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/db';
import type { Account, NewAccount } from '../db/types';
import { createAccount, createAccountWithId, recordFollowerHistory, updateAccount } from '../db/repository';
import { isPlaceholderHandle, planSessionImport } from '../lib/sessionImport';
import type { SessionAccountToCreate } from '../lib/sessionImport';
import { executor } from '../executor';
import { accountsToCsv } from '../lib/accountCsv';
import { downloadTextFile } from '../lib/csv';
import { compactCount, checkedAtLabel } from '../lib/format';
import { errorMessageOf, SESSION_EXPIRED_MESSAGE } from '../lib/errorMessage';
import { checkExtensionReady } from '../lib/extensionPrecheck';
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
  const settingsRow = useLiveQuery(() => db.settings.get('app'), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const proxyGroups = useLiveQuery(() => db.proxyGroups.toArray(), [], []);
  const emails = useLiveQuery(() => db.emailAddresses.toArray(), [], []);
  const emailById = useMemo(
    () => new Map((emails ?? []).map((e) => [e.id, e] as const)),
    [emails],
  );

  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const { mode, linkedIds, linkedSessions, refresh: refreshLinked } = useLinkedAccounts();
  const [refreshingLink, setRefreshingLink] = useState(false);
  const [importing, setImporting] = useState(false);

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
    // 拡張モードではジョブを送る前に疎通確認（接続＋Cookie API）。
    // ダメならここで止めて理由を出し、生のエラーが出る前に防ぐ。
    if (mode === 'extension') {
      const ready = await checkExtensionReady();
      if (!ready.ok) {
        toast.push(ready.message, 'err');
        return;
      }
    }
    setCheckingId(account.id);
    try {
      const result = await executor.checkAccount(account);
      // セッション切れ（401/403）は「ログアウト状態」という結果として
      // 返る。成功トーストにせず、再登録を促す文言を出す。
      if (result.sessionExpired) {
        toast.push(`@${account.handle}：${SESSION_EXPIRED_MESSAGE}`, 'err');
        return;
      }
      // フォロワー数が不明（-1）のときは履歴に残さない。
      if (result.followers >= 0) await recordFollowerHistory(account.id, result.followers);
      toast.push(
        `@${account.handle} をチェックしました（フォロワー ${result.followers.toLocaleString('ja-JP')}）`,
        'ok',
      );
    } catch (err) {
      // errorMessageOf 経由にすることで、拡張の Cookie API が無いときの
      // 生の TypeError も日本語の説明に置き換わる。
      const detail = errorMessageOf(err, '原因不明のエラー');
      // 取り込み時に付けた仮ハンドル（linked-…）はX上に存在しないため、
      // チェックは必ず「見つかりません」になる。原因をそのまま伝える。
      if (account.handle.startsWith('linked-')) {
        toast.push(
          `@${account.handle} は仮ハンドルのためチェックできません。アカウント編集で本当の @ハンドルに直してからもう一度チェックしてください`,
          'err',
        );
      } else {
        toast.push(`@${account.handle} のチェックに失敗しました：${detail}`, 'err');
      }
    } finally {
      setCheckingId(null);
    }
  };

  const runBulkCheck = async () => {
    // 1件ずつ失敗する前に、拡張モードでは疎通確認を1回だけ行う。
    if (mode === 'extension') {
      const ready = await checkExtensionReady();
      if (!ready.ok) {
        toast.push(ready.message, 'err');
        return;
      }
    }
    const targets = filtered;
    let done = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const account of targets) {
      setBulkProgress(`チェック中 ${done + 1}/${targets.length}: @${account.handle}`);
      try {
        const result = await executor.checkAccount(account);
        if (result.sessionExpired) {
          failed++;
          firstError ??= `@${account.handle}：${SESSION_EXPIRED_MESSAGE}`;
        } else if (result.followers >= 0) {
          await recordFollowerHistory(account.id, result.followers);
        }
      } catch (err) {
        // 1件の失敗で全体を止めない（XBoard と同じ）が、件数と
        // 最初の理由は残して最後にまとめて知らせる。
        failed++;
        firstError ??= `@${account.handle}：${errorMessageOf(err, '原因不明のエラー')}`;
      }
      done++;
    }
    setBulkProgress(null);
    toast.push(
      failed === 0
        ? `${done}件のアカウントチェックが完了しました`
        : `${done}件のアカウントチェックが完了しました（${failed}件失敗：${firstError ?? '原因不明のエラー'}）`,
      failed === 0 ? 'ok' : 'err',
    );
  };

  /**
   * 拡張で連携済みのセッションを台帳に取り込む。連携だけでは台帳に
   * アカウントが増えないため、このボタンが無いと「連携したのに一覧に
   * 出ない」ように見える。セッションのIDをそのまま台帳のIDにするので、
   * 取り込んだ直後から「連携済み」バッジが付く。
   * ハンドルが無いセッションは拡張に本人確認して本物のハンドルで作る。
   * 解決できなければ作らない（仮ハンドル linked-… は作らない）。
   * 過去の取り込みで残った仮ハンドルも、同じ本人確認で直す。
   */
  const importLinkedSessions = async () => {
    if (linkedSessions === null) return;
    setImporting(true);
    try {
      const plan = planSessionImport(
        linkedSessions,
        (accounts ?? []).map((a) => a.id),
      );
      const resolved: SessionAccountToCreate[] = [];
      const skipped: string[] = [];
      for (const accountId of plan.needsHandle) {
        try {
          const identity = await executor.resolveAccountIdentity(accountId);
          resolved.push({ accountId: identity.accountId, handle: identity.handle });
        } catch {
          skipped.push(accountId);
        }
      }
      let repaired = 0;
      const linkedById = new Map(linkedSessions.map((s) => [s.accountId, s]));
      for (const account of accounts ?? []) {
        if (!isPlaceholderHandle(account.handle) || !linkedById.has(account.id)) continue;
        try {
          const identity = await executor.resolveAccountIdentity(account.id);
          await updateAccount(account.id, {
            handle: identity.handle,
            displayName: identity.handle,
          });
          repaired += 1;
        } catch {
          // 直せなければ仮ハンドルのまま残す（チェック時の案内は従来通り）。
        }
      }
      const created = [...plan.toCreate, ...resolved];
      for (const item of created) {
        await createAccountWithId(item.accountId, {
          handle: item.handle,
          displayName: item.handle,
          groupId: null,
          proxyGroupId: null,
          status: 'logged_in',
          followers: 0,
          following: 0,
          notifications: 0,
          dmCount: 0,
          searchBan: 'unknown',
        });
      }
      const notes = [
        created.length > 0
          ? `${created.length}件を取り込みました（${plan.alreadyLinked}件は連携済みでした）`
          : `取り込むアカウントはありませんでした（${plan.alreadyLinked}件は連携済みでした）`,
      ];
      if (repaired > 0) notes.push(`${repaired}件の仮ハンドルを本物のハンドルに修正しました`);
      if (skipped.length > 0) notes.push(`${skipped.length}件はハンドルを確認できず見送りました`);
      toast.push(notes.join('。'), skipped.length > 0 ? 'err' : 'ok');
      await refreshLinked();
    } catch {
      toast.push('拡張の連携の取り込みに失敗しました', 'err');
    } finally {
      setImporting(false);
    }
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
          <>
            <Button
              onClick={importLinkedSessions}
              disabled={importing || linkedSessions === null}
            >
              {importing ? '取り込み中…' : '拡張の連携を取り込む'}
            </Button>{' '}
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
          </>
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
              {a.emailId && emailById.get(a.emailId) && (
                <>
                  <br />
                  <span className="mono faded" style={{ fontSize: 11.5 }}>
                    ✉ {emailById.get(a.emailId)!.address}
                  </span>
                </>
              )}
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
        行をクリックすると詳細が開きます。削除は詳細画面から行えます。チェックは
        {settingsRow?.settings.executorMode === 'extension' ? 'Chrome 拡張' : 'シミュレータ'}
        Executor 経由で実行され、結果は台帳に反映されます。
      </p>

      {modal.kind === 'add' && (
        <Modal title="アカウント追加" onClose={() => setModal({ kind: 'none' })}>
          <AccountForm
            groups={groups ?? []}
            proxyGroups={proxyGroups ?? []}
            emails={emails ?? []}
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
            emails={emails ?? []}
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
