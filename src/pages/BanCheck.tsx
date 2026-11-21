import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { BanCheckResult } from '../db/types';
import { runBanCheckBatch, searchBanVerdict } from '../lib/banCheckService';
import { executor } from '../executor';
import {
  SEARCH_QUERIES_PER_CHECK,
  SEARCH_QUERIES_PER_WINDOW,
} from '../lib/searchBanPacing';
import { checkedAtLabel } from '../lib/format';
import { Button, useToast } from '../components/ui';

function verdictMark(value: boolean | null): string {
  return value === null ? '⚠' : value ? '○' : '✗';
}

function verdictLabel(result: BanCheckResult): string {
  const verdict = searchBanVerdict(result.topicVisible, result.latestVisible);
  return { visible: '表示OK', topic_hidden: '話題のみ非表示', both_hidden: '両方非表示', unknown: '取得失敗' }[verdict];
}

export function BanCheck() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const history = useLiveQuery(
    () => db.banCheckResults.orderBy('checkedAt').reverse().limit(50).toArray(),
    [],
    [],
  );

  const loggedIn = useMemo(
    () => (accounts ?? []).filter((a) => a.status === 'logged_in'),
    [accounts],
  );
  const [checkerIds, setCheckerIds] = useState<string[] | null>(null);
  const [groupId, setGroupId] = useState<string>('all');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, phase: '', message: '' });
  const [lastResults, setLastResults] = useState<BanCheckResult[] | null>(null);

  // Default checkers: all logged-in accounts (the manual's "サーチバン
  // 確認アカウント" setting has no stored value yet, so all are used).
  const effectiveCheckers = checkerIds ?? loggedIn.map((a) => a.id);
  const targets = useMemo(() => {
    const all = accounts ?? [];
    return groupId === 'all' ? all : all.filter((a) => a.groupId === groupId);
  }, [accounts, groupId]);

  const queriesUsed = progress.done * SEARCH_QUERIES_PER_CHECK;
  const budgetPct = Math.min(100, (queriesUsed / SEARCH_QUERIES_PER_WINDOW) * 100);

  const run = async () => {
    if (effectiveCheckers.length === 0) {
      toast.push('チェックに使えるログイン済みアカウントがありません', 'err');
      return;
    }
    if (targets.length === 0) {
      toast.push('チェック対象のアカウントがありません', 'err');
      return;
    }
    setRunning(true);
    setLastResults(null);
    setProgress({ done: 0, total: targets.length, phase: 'checking', message: '' });
    try {
      const results = await runBanCheckBatch({
        checkerIds: effectiveCheckers,
        targetIds: targets.map((a) => a.id),
        onProgress: (p) => setProgress({ ...p }),
      });
      setLastResults(results);
      const hidden = results.filter((r) => r.topicVisible === false || r.latestVisible === false).length;
      toast.push(
        `サーチバンチェックが完了しました（${results.length}件中 ${hidden}件が非表示）`,
        hidden === 0 ? 'ok' : 'info',
      );
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'チェックに失敗しました', 'err');
    } finally {
      setRunning(false);
    }
  };

  const [replyDemo, setReplyDemo] = useState<{ text: string; postedAt: number }[] | null>(null);
  const [replyLoading, setReplyLoading] = useState(false);
  const loadReplyDemo = async () => {
    const account = loggedIn[0];
    if (!account) {
      toast.push('ログイン済みアカウントがありません', 'err');
      return;
    }
    setReplyLoading(true);
    try {
      // The manual does not document a reply-ban verdict procedure;
      // the documented way is to look at the latest-replies list.
      // These rows come from the simulator's analytics fetch and are
      // labelled as demo data.
      const posts = await executor.fetchPostAnalytics(account, [account]);
      setReplyDemo(posts.slice(0, 10).map((p) => ({ text: p.text, postedAt: p.postedAt })));
    } finally {
      setReplyLoading(false);
    }
  };

  const handleOf = (id: string) => accounts?.find((a) => a.id === id)?.handle ?? '—';

  if (!accounts) return <p className="faded">読み込み中…</p>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">06</span>バンチェック
          </h1>
          <p className="page-lede">
            登録アカウントのポストが検索結果の「話題」と「最新」に表示されるか確認します（§9-1）。
            Xの検索は15分に50回までで、1アカウントのチェックに2回使います。
          </p>
        </div>
      </div>

      <section className="panel">
        <h2 className="panel-title">サーチバンチェックを実行</h2>
        <div className="form-row">
          <div className="field">
            <label>チェックに使うアカウント（ログイン済みのみ）</label>
            {loggedIn.length === 0 ? (
              <p className="faded" style={{ fontSize: 13 }}>ログイン済みのアカウントがありません。</p>
            ) : (
              <div className="pick-list">
                {loggedIn.map((a) => (
                  <label key={a.id} className="pick-row">
                    <input
                      type="checkbox"
                      checked={effectiveCheckers.includes(a.id)}
                      disabled={running}
                      onChange={(e) =>
                        setCheckerIds(
                          e.target.checked
                            ? [...effectiveCheckers, a.id]
                            : effectiveCheckers.filter((id) => id !== a.id),
                        )
                      }
                    />
                    <span className="pick-main">
                      <strong>{a.displayName}</strong>{' '}
                      <span className="mono faded" style={{ fontSize: 12 }}>@{a.handle}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="hint">複数選ぶと分担してチェックするため、待ち時間がその分だけ減ります。</p>
          </div>
          <div className="field">
            <label htmlFor="ban-group">チェックするグループ</label>
            <select id="ban-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={running}>
              <option value="all">全グループ（{accounts.length}件）</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}（{accounts.filter((a) => a.groupId === g.id).length}件）
                </option>
              ))}
            </select>
            <p className="hint">
              対象 {targets.length}件 / 検索クエリ {targets.length * SEARCH_QUERIES_PER_CHECK}回
              {targets.length > 25 * Math.max(1, effectiveCheckers.length) &&
                ` / 15分制限を超えるため途中で自動待機が入ります`}
            </p>
          </div>
        </div>

        {running && (
          <div style={{ marginBottom: 12 }}>
            <div className="progress-line">
              <span>{progress.phase === 'waiting' ? '自動待機中' : 'チェック中'}</span>
              <span className="mono">
                {progress.done}/{progress.total}
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: 'var(--c-line)',
                borderRadius: 3,
                overflow: 'hidden',
                marginTop: 6,
              }}
            >
              <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, height: '100%', background: 'var(--c-amber)' }} />
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              検索クエリ使用量: {queriesUsed} / {SEARCH_QUERIES_PER_WINDOW}（15分あたり）
            </p>
            <div style={{ height: 6, background: 'var(--c-line)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${budgetPct}%`, height: '100%', background: budgetPct >= 100 ? 'var(--c-warn)' : 'var(--c-info)' }} />
            </div>
            {progress.message && <p className="hint" style={{ marginTop: 6 }}>{progress.message}</p>}
          </div>
        )}

        <div className="toolbar">
          <Button variant="primary" onClick={run} disabled={running || targets.length === 0}>
            {running ? 'チェック中…' : 'サーチバンチェックを実行'}
          </Button>
          <span className="faded" style={{ fontSize: 12.5 }}>
            結果は履歴に保存されます。定期チェックは「設定」から有効化できます。
          </span>
        </div>
      </section>

      {lastResults && (
        <>
          <h2 className="section-title">今回の結果</h2>
          <div className="ledger-simple">
            {lastResults.map((r) => (
              <div key={r.id} className="simple-row">
                <span style={{ minWidth: 34, fontSize: 18 }}>
                  {verdictMark(r.topicVisible)} {verdictMark(r.latestVisible)}
                </span>
                <span className="grow">
                  <strong>@{r.handle}</strong>{' '}
                  <span className="faded" style={{ fontSize: 12.5 }}>{verdictLabel(r)}</span>
                  <div className="faded mono" style={{ fontSize: 12 }}>
                    話題 {verdictMark(r.topicVisible)} / 最新 {verdictMark(r.latestVisible)}
                    {' '}・確認: @{handleOf(r.checkedByAccountId)}・{checkedAtLabel(r.checkedAt)}
                  </div>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">チェック履歴</h2>
      {(history ?? []).length === 0 ? (
        <p className="faded">まだチェック履歴がありません。</p>
      ) : (
        <div className="ledger-simple">
          {(history ?? []).map((r) => (
            <div key={r.id} className="simple-row">
              <span style={{ minWidth: 34, fontSize: 18 }}>
                {verdictMark(r.topicVisible)} {verdictMark(r.latestVisible)}
              </span>
              <span className="grow">
                <strong>@{r.handle}</strong>{' '}
                <span className="faded" style={{ fontSize: 12.5 }}>{verdictLabel(r)}</span>
                <div className="faded mono" style={{ fontSize: 12 }}>
                  確認: @{handleOf(r.checkedByAccountId)}・{checkedAtLabel(r.checkedAt)}
                </div>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">リプライバンチェック</h2>
      <section className="panel">
        <p style={{ fontSize: 13.5, marginTop: 0 }}>
          マニュアルにリプライバンの判定手順・判定基準は文書化されていません（§9-2）。
          文書化されているのは「各アカウントの最新リプライ一覧で確認する」という方式のみです。
          下の一覧はシミュレータのデモデータで、実際の判定にはX上で最新リプライが表示されるかをご確認ください。
        </p>
        <div className="toolbar">
          <Button onClick={loadReplyDemo} disabled={replyLoading || loggedIn.length === 0}>
            {replyLoading ? '取得中…' : '最新リプライ一覧を表示（デモ）'}
          </Button>
          <span className="faded" style={{ fontSize: 12.5 }}>
            対象: @{loggedIn[0]?.handle ?? '—'}
          </span>
        </div>
        {replyDemo && (
          <div className="ledger-simple" style={{ marginTop: 12 }}>
            {replyDemo.map((r, i) => (
              <div key={i} className="simple-row">
                <span className="grow">
                  <span style={{ fontSize: 13.5 }}>{r.text}</span>
                  <div className="faded mono" style={{ fontSize: 12 }}>{checkedAtLabel(r.postedAt)}</div>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
