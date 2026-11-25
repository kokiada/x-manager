import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db } from '../db/db';
import type { NewAccount } from '../db/types';
import { EMAIL_PROVIDER_LABELS, SEARCH_BAN_LABELS } from '../db/types';
import { deleteAccount, recordFollowerHistory, updateAccount } from '../db/repository';
import { runSingleBanCheck } from '../lib/banCheckService';
import { executor } from '../executor';
import { checkedAtLabel, fullCount, maskToken } from '../lib/format';
import { errorMessageOf, SESSION_EXPIRED_MESSAGE } from '../lib/errorMessage';
import { checkExtensionReady } from '../lib/extensionPrecheck';
import { AccountForm } from '../components/AccountForm';
import { Button, Modal, StatusBadge, Tooltip, useToast } from '../components/ui';
import { useLinkedAccounts } from '../hooks/useLinkedAccounts';
import { isLinkedAccount } from '../lib/extensionLink';

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  // undefined = still loading, null = no such account
  const account = useLiveQuery(
    async () => (id ? ((await db.accounts.get(id)) ?? null) : null),
    [id],
    undefined,
  );
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const proxyGroups = useLiveQuery(() => db.proxyGroups.toArray(), [], []);
  const emails = useLiveQuery(() => db.emailAddresses.toArray(), [], []);
  const linkedEmail = account
    ? (emails ?? []).find((e) => e.id === account.emailId)
    : undefined;

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'check' | 'ban' | null>(null);
  const { mode, linkedIds } = useLinkedAccounts();
  const linked = mode === 'extension' && isLinkedAccount(linkedIds ?? undefined, account?.id ?? '');

  const copyAccountId = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.id);
      toast.push('アカウントIDをコピーしました', 'ok');
    } catch {
      toast.push('コピーに失敗しました', 'err');
    }
  };

  if (account === undefined) return <p className="faded">読み込み中…</p>;
  if (account === null || !account) {
    return (
      <div>
        <p>アカウントが見つかりません。</p>
        <Link className="btn" to="/accounts">一覧に戻る</Link>
      </div>
    );
  }

  const group = groups?.find((g) => g.id === account.groupId);
  const proxy = proxyGroups?.find((p) => p.id === account.proxyGroupId);

  const runCheck = async () => {
    // 拡張モードではジョブを送る前に疎通確認（接続＋Cookie API）。
    if (mode === 'extension') {
      const ready = await checkExtensionReady();
      if (!ready.ok) {
        toast.push(ready.message, 'err');
        return;
      }
    }
    setBusy('check');
    try {
      const result = await executor.checkAccount(account);
      // セッション切れ（401/403）は「ログアウト状態」という結果として
      // 返る。成功トーストにせず、再登録を促す文言を出す。
      if (result.sessionExpired) {
        toast.push(SESSION_EXPIRED_MESSAGE, 'err');
        return;
      }
      // フォロワー数が不明（-1）のときは履歴に残さない。
      if (result.followers >= 0) await recordFollowerHistory(account.id, result.followers);
      toast.push(`@${account.handle} のチェックが完了しました`, 'ok');
    } catch (err) {
      toast.push(
        `チェックに失敗しました：${errorMessageOf(err, '原因不明のエラー')}`,
        'err',
      );
    } finally {
      setBusy(null);
    }
  };

  const runBanCheck = async () => {
    setBusy('ban');
    try {
      const result = await runSingleBanCheck(account.id);
      if (!result) {
        toast.push('チェックに使えるログイン済みアカウントが他にありません', 'err');
      } else if (result.topicVisible === null) {
        toast.push('サーチバンチェックの取得に失敗しました（⚠）', 'err');
      } else {
        const via = await db.accounts.get(result.checkedByAccountId);
        toast.push(
          `サーチバン判定: 話題 ${result.topicVisible ? '○' : '✗'} / 最新 ${result.latestVisible ? '○' : '✗'}（確認: @${via?.handle ?? '—'}）`,
          result.topicVisible && result.latestVisible ? 'ok' : 'info',
        );
      }
    } catch (err) {
      // これまで catch が無く、拡張の失敗が未処理のままだった。
      toast.push(
        `サーチバンチェックに失敗しました：${errorMessageOf(err, '原因不明のエラー')}`,
        'err',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`@${account.handle}（${account.displayName}）を削除しますか？この操作は戻せません。`))
      return;
    await deleteAccount(account.id);
    toast.push(`@${account.handle} を削除しました`, 'ok');
    navigate('/accounts');
  };

  const submitEdit = async (input: NewAccount) => {
    await updateAccount(account.id, input);
    toast.push(`@${input.handle} を更新しました`, 'ok');
    setEditing(false);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">03</span>
            {account.displayName}
          </h1>
          <p className="page-lede mono">@{account.handle}</p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Link className="btn ghost" to="/accounts">← 一覧</Link>
          <Button onClick={runCheck} disabled={busy !== null}>
            {busy === 'check' ? 'チェック中…' : 'アカウントチェック'}
          </Button>
          <Button onClick={runBanCheck} disabled={busy !== null}>
            {busy === 'ban' ? '判定中…' : 'サーチバンチェック'}
          </Button>
          <Button variant="primary" onClick={() => setEditing(true)}>
            編集
          </Button>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-cell">
          <div className="k">ステータス</div>
          <div className="v">
            <StatusBadge status={account.status} />{' '}
            {linked && <span className="badge linked">連携済み</span>}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">
            アカウントID（拡張の連携用）{' '}
            <Tooltip label="Chrome 拡張のポップアップにこのIDと auth_token を登録すると連携されます。">
              <span aria-hidden="true">？</span>
            </Tooltip>
          </div>
          <div className="v mono" style={{ fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{account.id}</span>
            <Button small onClick={copyAccountId}>
              コピー
            </Button>
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">サーチバン判定</div>
          <div className="v">{SEARCH_BAN_LABELS[account.searchBan]}</div>
        </div>
        <div className="detail-cell">
          <div className="k">フォロワー / フォロー中</div>
          <div className="v mono">
            {fullCount(account.followers)} / {fullCount(account.following)}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">通知 / DM</div>
          <div className="v mono">
            {account.notifications} 件 / {account.dmCount} 件
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">グループ</div>
          <div className="v">{group?.name ?? '未分類'}</div>
        </div>
        <div className="detail-cell">
          <div className="k">プロキシ</div>
          <div className="v">
            {proxy ? (
              <>
                {proxy.name}
                <div className="mono faded" style={{ fontSize: 12.5 }}>
                  {proxy.host}:{proxy.port}
                  {proxy.username ? ` / 認証 ${proxy.username}` : ''}
                </div>
              </>
            ) : (
              '直接接続'
            )}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">メールアドレス</div>
          <div className="v mono" style={{ fontSize: 13 }}>
            {linkedEmail ? (
              <>
                {linkedEmail.address}
                <div className="faded" style={{ fontSize: 12.5 }}>
                  {linkedEmail.label ? `${linkedEmail.label} ・ ` : ''}
                  {EMAIL_PROVIDER_LABELS[linkedEmail.provider]}
                </div>
              </>
            ) : (
              <span className="faded">未設定</span>
            )}
          </div>
        </div>
        <div className="detail-cell">
          <div className="k">auth_token</div>
          <div className="v mono">{maskToken(account.authToken)}</div>
        </div>
        <div className="detail-cell">
          <div className="k">最終チェック</div>
          <div className="v mono">{checkedAtLabel(account.lastCheckedAt)}</div>
        </div>
        {account.memo && (
          <div className="detail-cell" style={{ gridColumn: '1 / -1' }}>
            <div className="k">メモ</div>
            <div className="v" style={{ fontWeight: 500 }}>{account.memo}</div>
          </div>
        )}
      </div>

      <div className="toolbar" style={{ marginTop: 24 }}>
        <span className="spacer" />
        <Button variant="danger" onClick={handleDelete}>
          このアカウントを削除
        </Button>
      </div>

      {editing && (
        <Modal title="アカウント編集" onClose={() => setEditing(false)}>
          <AccountForm
            initial={account}
            groups={groups ?? []}
            proxyGroups={proxyGroups ?? []}
            emails={emails ?? []}
            onSubmit={submitEdit}
            onCancel={() => setEditing(false)}
          />
        </Modal>
      )}
    </div>
  );
}
