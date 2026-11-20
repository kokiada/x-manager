import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db/db';
import type { CheckRun } from '../db/types';
import { SEARCH_BAN_LABELS } from '../db/types';
import { listCheckRuns } from '../db/repository';
import { executor } from '../executor';
import { accountsForGroup, runSearchBanChecks, searchBanVerdict } from '../lib/checkService';
import { checkedAtLabel } from '../lib/format';
import { Button, useToast } from '../components/ui';

function VerdictMark({ value }: { value: boolean | null | undefined }) {
  if (value === true) return <span style={{ color: 'var(--c-ok)' }}>○ 表示</span>;
  if (value === false) return <span style={{ color: 'var(--c-bad)' }}>✗ 非表示</span>;
  return <span style={{ color: 'var(--c-amber)' }}>⚠ 取得失敗</span>;
}

export function BanCheck() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const runs = useLiveQuery(() => listCheckRuns('search_ban', 10), [], undefined);

  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [checkerIds, setCheckerIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const loggedIn = useMemo(
    () => (accounts ?? []).filter((a) => a.status === 'logged_in'),
    [accounts],
  );
  const targets = useMemo(() => {
    const all = accounts ?? [];
    return groupFilter === 'all' ? all : all.filter((a) => a.groupId === groupFilter);
  }, [accounts, groupFilter]);

  const latest: CheckRun | undefined = runs?.[0];

  const run = async () => {
    if (!accounts) return;
    const checkers = loggedIn.filter((a) => checkerIds.includes(a.id));
    if (checkers.length === 0) {
      toast.push('チェックに使うログイン済みアカウントを1つ以上選んでください', 'err');
      return;
    }
    if (targets.length === 0) {
      toast.push('チェック対象のアカウントがありません', 'err');
      return;
    }
    setRunning(true);
    try {
      const runResult = await runSearchBanChecks(
        await accountsForGroup(groupFilter === 'all' ? null : groupFilter),
        checkers,
        executor,
        {
          onProgress: (done, total, handle) =>
            setProgress(done >= total ? null : `チェック中 ${done + 1}/${total}: @${handle}`),
        },
      );
      const ok = runResult.entries.filter((e) => e.topicVisible !== null).length;
      const hidden = runResult.entries.filter(
        (e) => searchBanVerdict(e.topicVisible ?? null, e.latestVisible ?? null) !== 'visible' &&
          e.topicVisible !== null,
      ).length;
      toast.push(`サーチバンチェック完了：${ok}件判定、うち非表示 ${hidden}件`, 'ok');
    } catch {
      toast.push('サーチバンチェックに失敗しました', 'err');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">06</span>バンチェック
          </h1>
          <p className="page-lede">
            登録アカウントのポストが検索の「話題」「最新」に表示されるかを、他のログイン済みアカウントから確認します。
          </p>
        </div>
      </div>

      <h2 className="section-title">チェックを実行</h2>
      <div className="toolbar">
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="チェック対象グループ"
        >
          <option value="all">全グループ（{accounts?.length ?? 0}件）</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <span className="faded" style={{ fontSize: 12.5 }}>
          対象 {targets.length}件 ・ 検索は15分に50回まで。1件のチェックで2回使います。
        </span>
        <span className="spacer" />
        {progress ? (
          <span className="progress-line">{progress}</span>
        ) : (
          <Button variant="primary" onClick={run} disabled={running || targets.length === 0}>
            {running ? 'チェック中…' : 'サーチバンチェックを実行'}
          </Button>
        )}
      </div>

      <div className="field" style={{ marginBottom: 16 }}>
        <label htmlFor="ban-checkers">チェックに使うアカウント（ログイン済みのみ・複数可。分担すると待ち時間が減ります）</label>
        {loggedIn.length === 0 && <p className="faded">ログイン済みのアカウントがありません。</p>}
        <div className="pick-list" id="ban-checkers">
          {loggedIn.map((a) => (
            <label key={a.id} className="pick-row">
              <input
                type="checkbox"
                checked={checkerIds.includes(a.id)}
                onChange={(e) =>
                  setCheckerIds((prev) =>
                    e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id),
                  )
                }
              />
              <span className="pick-main">
                <strong>{a.displayName}</strong>{' '}
                <span className="mono faded">@{a.handle}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <h2 className="section-title">最新の結果</h2>
      {!latest && <p className="faded">まだチェック履歴がありません。</p>}
      {latest && (
        <div className="ledger-simple">
          <div className="job-head">
            <strong>
              {checkedAtLabel(latest.startedAt)}
              {latest.scheduled ? '（定期チェック）' : '（手動）'}
            </strong>
            <span className="spacer" />
            <span className="faded" style={{ fontSize: 12.5 }}>
              {latest.entries.length}件
            </span>
          </div>
          <div className="job-entries">
            {latest.entries.map((e) => {
              const verdict = searchBanVerdict(e.topicVisible ?? null, e.latestVisible ?? null);
              return (
                <div key={e.accountId} className="entry-row">
                  <span className="grow">
                    <strong>@{e.handle}</strong>{' '}
                    <span className="badge plain">{SEARCH_BAN_LABELS[verdict]}</span>
                    {e.error && <span className="faded"> — {e.error}</span>}
                  </span>
                  <span>
                    話題 <VerdictMark value={e.topicVisible} />
                  </span>
                  <span>
                    最新 <VerdictMark value={e.latestVisible} />
                  </span>
                  {e.checkedByHandle && (
                    <span className="faded mono" style={{ fontSize: 12 }}>
                      via @{e.checkedByHandle}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <h2 className="section-title">履歴</h2>
      {(runs ?? []).slice(1).map((r) => (
        <div key={r.id} className="simple-row">
          <span className="grow">
            {checkedAtLabel(r.startedAt)}
            {r.scheduled ? '（定期）' : '（手動）'}
          </span>
          <span className="faded" style={{ fontSize: 12.5 }}>
            {r.entries.length}件 ／ 非表示{' '}
            {
              r.entries.filter(
                (e) => searchBanVerdict(e.topicVisible ?? null, e.latestVisible ?? null) !== 'visible' && e.topicVisible !== null,
              ).length
            }
            件
          </span>
        </div>
      ))}
      {(runs ?? []).length <= 1 && <p className="faded">履歴はまだありません。</p>}

      <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
        定期チェックは<Link to="/settings">設定</Link>
        の時刻にアプリを開いている間だけ動き、開始時刻を15分以上過ぎた回は見送ります。
        判定は参考値です。実際の検索結果はXで確認してください。
      </p>
    </div>
  );
}
