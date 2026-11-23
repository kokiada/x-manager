import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Account, PostAnalytics, PostTracking } from '../db/types';
import { executor } from '../executor';
import {
  createPostTracking,
  listFollowerHistory,
  listPostAnalytics,
  savePostAnalytics,
} from '../db/repository';
import {
  fetchCap,
  fetcherError,
  followerTrend,
  requiredFetchers,
  simulateMetrics,
  sortAnalytics,
  type AnalyticsSortKey,
} from '../lib/analytics';
import { checkedAtLabel, fullCount } from '../lib/format';
import { errorMessageOf } from '../lib/errorMessage';
import { Button, useToast } from '../components/ui';

const SORT_LABELS: Record<AnalyticsSortKey, string> = {
  likes: 'いいね',
  reposts: 'リポスト',
  bookmarks: 'ブックマーク',
  views: '表示回数',
  date: '投稿日',
  engagement: 'エンゲージメント率',
};

/** Tracking snapshot marks (research §12-2). */
const TRACK_MARKS_H = [0.5, 1, 3, 12, 24, 48];

type Tab = 'analytics' | 'tracking' | 'followers';

export function Analytics() {
  const [tab, setTab] = useState<Tab>('analytics');
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const settings = useLiveQuery(() => db.settings.get('app'), [], undefined);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">07</span>分析
          </h1>
          <p className="page-lede">
            ポスト分析・ポスト追跡・フォロワー推移（§12）。取得は{settings?.settings.executorMode === 'extension' ? 'Chrome 拡張' : settings?.settings.executorMode === 'desktop' ? 'デスクトップ' : 'シミュレータ'} Executor 経由です。
          </p>
        </div>
      </div>

      <div className="view-tabs" role="tablist" aria-label="分析の表示切替">
        {(
          [
            ['analytics', 'ポスト分析'],
            ['tracking', 'ポスト追跡'],
            ['followers', 'フォロワー推移'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'analytics' && <PostAnalyticsTab accounts={accounts ?? []} planAccounts={settings?.settings.planAccounts ?? 20} />}
      {tab === 'tracking' && <PostTrackingTab accounts={accounts ?? []} groups={groups ?? []} />}
      {tab === 'followers' && <FollowerTrendTab accounts={accounts ?? []} />}
    </div>
  );
}

/* ---------------------------- post analytics ---------------------------- */

function PostAnalyticsTab({
  accounts,
  planAccounts,
}: {
  accounts: Account[];
  planAccounts: number;
}) {
  const toast = useToast();
  const loggedIn = accounts.filter((a) => a.status === 'logged_in');
  const [accountId, setAccountId] = useState('');
  const [fetcherIds, setFetcherIds] = useState<string[]>([]);
  const [wantCount, setWantCount] = useState(200);
  const [sortKey, setSortKey] = useState<AnalyticsSortKey>('views');
  const [fetching, setFetching] = useState(false);
  const rows = useLiveQuery(
    () => (accountId ? listPostAnalytics(accountId) : Promise.resolve([] as PostAnalytics[])),
    [accountId],
    [],
  );

  const account = accounts.find((a) => a.id === accountId);
  const cap = fetchCap(planAccounts, false);
  const effectiveCount = Math.min(wantCount, cap);
  const fetchers = loggedIn.filter((a) => fetcherIds.includes(a.id));
  const error = fetcherError(effectiveCount, fetchers.length);

  const sorted = useMemo(() => sortAnalytics(rows ?? [], sortKey), [rows, sortKey]);

  const fetchRows = async () => {
    if (!account) return;
    if (error) {
      toast.push(error, 'err');
      return;
    }
    setFetching(true);
    try {
      const items = await executor.fetchPostAnalytics(account, fetchers);
      await savePostAnalytics(account.id, items.map((i) => ({ ...i, handle: account.handle, fetcherAccountId: fetchers[0]?.id ?? account.id })));
      toast.push(`@${account.handle} のポスト分析を取得しました（${items.length}件）`, 'ok');
    } catch (err) {
      toast.push(
        `ポスト分析の取得に失敗しました：${errorMessageOf(err, '原因不明のエラー')}`,
        'err',
      );
    } finally {
      setFetching(false);
    }
  };

  const copyForAi = async () => {
    if (!account || sorted.length === 0) return;
    const top = sorted.slice(0, 10);
    const lines = [
      `ポスト分析（@${account.handle}、${sorted.length}件、並び順: ${SORT_LABELS[sortKey]}）`,
      ...top.map(
        (r, i) =>
          `${i + 1}. ${checkedAtLabel(r.postedAt)} いいね${r.likes} リポスト${r.reposts} ブックマーク${r.bookmarks} 表示${r.views}「${r.text}」`,
      ),
      `合計: いいね${sorted.reduce((s, r) => s + r.likes, 0)} リポスト${sorted.reduce((s, r) => s + r.reposts, 0)} 表示${sorted.reduce((s, r) => s + r.views, 0)}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.push('AI分析用のテキストをコピーしました', 'ok');
    } catch {
      toast.push('コピーに失敗しました', 'err');
    }
  };

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">ポスト分析（§12-1）</h2>
        <div className="form-row">
          <div className="field">
            <label htmlFor="an-account">分析するアカウント</label>
            <select id="an-account" value={accountId} onChange={(e) => { setAccountId(e.target.value); setFetcherIds([]); }}>
              <option value="">アカウントを選ぶ…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle}（{a.displayName}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="an-count">取得件数</label>
            <input
              id="an-count"
              type="number"
              min={1}
              max={cap}
              value={wantCount}
              onChange={(e) => setWantCount(Math.max(1, Number(e.target.value) || 1))}
            />
            <p className="hint">
              上限はプラン（{planAccounts}アカウント）の ×10 = {fullCount(cap)}件。
              {effectiveCount >= 1000 && ` ${effectiveCount.toLocaleString('ja-JP')}件には取得アカウントが${requiredFetchers(effectiveCount)}つ以上必要です。`}
            </p>
          </div>
        </div>
        <div className="field">
          <label>取得に使うアカウント（最大3つ）</label>
          <div className="pick-list">
            {loggedIn.map((a) => (
              <label key={a.id} className="pick-row">
                <input
                  type="checkbox"
                  checked={fetcherIds.includes(a.id)}
                  disabled={fetching || (!fetcherIds.includes(a.id) && fetcherIds.length >= 3)}
                  onChange={(e) =>
                    setFetcherIds(
                      e.target.checked
                        ? [...fetcherIds, a.id]
                        : fetcherIds.filter((id) => id !== a.id),
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
          {error && <p className="hint" style={{ color: 'var(--c-warn)' }}>{error}</p>}
        </div>
        <div className="toolbar">
          <Button variant="primary" onClick={fetchRows} disabled={fetching || !account || !!error}>
            {fetching ? '取得中…' : 'ポスト分析を取得'}
          </Button>
          <Button onClick={copyForAi} disabled={sorted.length === 0}>
            AI分析用にコピー
          </Button>
          <span className="faded" style={{ fontSize: 12.5 }}>
            {sorted.length > 0 ? `${sorted.length}件の結果（取得: ${checkedAtLabel(rows?.[0]?.fetchedAt)}）` : '結果はこの端末に履歴保存されます'}
          </span>
        </div>
      </section>

      {sorted.length > 0 && (
        <>
          <div className="toolbar" style={{ marginTop: 16 }}>
            <span className="faded" style={{ fontSize: 12.5 }}>並び替え:</span>
            {(Object.keys(SORT_LABELS) as AnalyticsSortKey[]).map((key) => (
              <Button key={key} small variant={sortKey === key ? 'primary' : 'default'} onClick={() => setSortKey(key)}>
                {SORT_LABELS[key]}
              </Button>
            ))}
          </div>
          <div className="ledger-simple">
            {sorted.map((r) => (
              <div key={r.id} className="simple-row">
                <span className="grow">
                  <span style={{ fontSize: 13.5 }}>{r.text}</span>
                  <div className="faded mono" style={{ fontSize: 12 }}>
                    {checkedAtLabel(r.postedAt)}・{r.postUrl}
                  </div>
                </span>
                <span className="mono" style={{ fontSize: 12.5, textAlign: 'right', minWidth: 190 }}>
                  ♥ {fullCount(r.likes)}　↻ {fullCount(r.reposts)}　🔖 {fullCount(r.bookmarks)}
                  <br />
                  👁 {fullCount(r.views)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------- post tracking ---------------------------- */

function PostTrackingTab({
  accounts,
  groups,
}: {
  accounts: Account[];
  groups: { id: string; name: string }[];
}) {
  const toast = useToast();
  const [groupId, setGroupId] = useState<string>('all');
  const [starting, setStarting] = useState(false);
  const tracked = useLiveQuery(
    () => db.postTracking.orderBy('postedAt').reverse().limit(100).toArray(),
    [],
    [],
  );
  const visible = (tracked ?? []).filter((t) => groupId === 'all' || t.groupId === groupId);

  const startTracking = async () => {
    const targets = accounts.filter(
      (a) => a.status === 'logged_in' && (groupId === 'all' || a.groupId === groupId),
    );
    if (targets.length === 0) {
      toast.push('追跡対象のログイン済みアカウントがありません', 'err');
      return;
    }
    setStarting(true);
    try {
      let created = 0;
      for (const account of targets) {
        // Take the account's recent posts and backfill the 30m–48h
        // snapshot marks from the simulator's metrics. In a real
        // executor these snapshots would be captured live over time;
        // the backfill is a demo approximation, labelled as such.
        const posts = await executor.fetchPostAnalytics(account, [account]);
        for (const post of posts.slice(0, 3)) {
          const ageH = (Date.now() - post.postedAt) / 3600_000;
          const snapshots = TRACK_MARKS_H.filter((h) => h <= ageH).map((h) => {
            // Deterministic backfill from the post's own metrics curve
            // (lib/analytics simulateMetrics): same post + same mark
            // always gives the same numbers.
            const sim = simulateMetrics(post.postId, h, account.followers);
            return {
              at: post.postedAt + h * 3600_000,
              views: sim.views,
              likes: sim.likes,
              reposts: sim.reposts,
              bookmarks: sim.bookmarks,
            };
          });
          // Always keep the latest values as the final snapshot.
          if (snapshots.length === 0 || snapshots[snapshots.length - 1].at < Date.now() - 60_000) {
            snapshots.push({ at: Date.now(), views: post.views, likes: post.likes, reposts: post.reposts, bookmarks: post.bookmarks });
          }
          await createPostTracking({
            accountId: account.id,
            postId: post.postId,
            postUrl: post.postUrl,
            text: post.text,
            postedAt: post.postedAt,
            snapshots,
            groupId: account.groupId ?? '',
          });
          created++;
        }
      }
      toast.push(`ポスト追跡を開始しました（${created}件）`, 'ok');
    } catch (err) {
      toast.push(
        `ポスト追跡の開始に失敗しました：${errorMessageOf(err, '原因不明のエラー')}`,
        'err',
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">ポスト追跡（ベータ版・§12-2）</h2>
        <p style={{ fontSize: 13.5, marginTop: 0 }}>
          登録アカウントの投稿について、投稿から30分・1時間・3時間・12時間・24時間・48時間の
          時点ごとの表示回数・いいね・リポスト・ブックマークを記録します。
          スナップショットはシミュレータの数値から補完したデモ表示です（実運用では起動中に10分おきに取得）。
        </p>
        <div className="form-row">
          <div className="field">
            <label htmlFor="trk-group">追跡するグループ</label>
            <select id="trk-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="all">全グループ</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="toolbar">
          <Button variant="primary" onClick={startTracking} disabled={starting}>
            {starting ? '開始中…' : '追跡を開始'}
          </Button>
          <span className="faded" style={{ fontSize: 12.5 }}>記録は新しい順に1万件まで保存されます</span>
        </div>
      </section>

      {visible.length === 0 ? (
        <p className="faded">追跡中のポストはまだありません。</p>
      ) : (
        visible.map((t) => <TrackingCard key={t.id} tracking={t} />)
      )}
    </div>
  );
}

function TrackingCard({ tracking }: { tracking: PostTracking }) {
  const first = tracking.snapshots[0];
  const last = tracking.snapshots[tracking.snapshots.length - 1];
  const growth = first && last && first.views > 0
    ? Math.round(((last.views - first.views) / first.views) * 100)
    : null;
  return (
    <section className="panel" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13.5 }}>{tracking.text}</div>
      <div className="faded mono" style={{ fontSize: 12, marginTop: 4 }}>
        {tracking.postUrl}・{checkedAtLabel(tracking.postedAt)}
        {growth !== null && `・表示回数 ${growth >= 0 ? '+' : ''}${growth}%（最初→最新）`}
      </div>
      <div className="ledger-simple" style={{ marginTop: 8 }}>
        {tracking.snapshots.map((s, i) => {
          const mark = TRACK_MARKS_H[i];
          const label = mark === undefined ? '現在' : mark < 1 ? '30分後' : `${mark}時間後`;
          return (
            <div key={i} className="simple-row">
              <span className="mono" style={{ minWidth: 64, fontSize: 12.5 }}>{label}</span>
              <span className="grow mono" style={{ fontSize: 12.5 }}>
                👁 {fullCount(s.views)}　♥ {fullCount(s.likes)}　↻ {fullCount(s.reposts)}　🔖 {fullCount(s.bookmarks)}
              </span>
              <span className="faded mono" style={{ fontSize: 12 }}>{checkedAtLabel(s.at)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------------------- follower trend ---------------------------- */

function FollowerTrendTab({ accounts }: { accounts: Account[] }) {
  const [accountId, setAccountId] = useState('');
  const history = useLiveQuery(
    () => (accountId ? listFollowerHistory(accountId) : Promise.resolve([])),
    [accountId],
    [],
  );
  const account = accounts.find((a) => a.id === accountId);
  const last90 = useMemo(() => {
    const rows = history ?? [];
    return rows.slice(-90);
  }, [history]);

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">フォロワー推移（§12-3）</h2>
        <div className="form-row">
          <div className="field">
            <label htmlFor="fw-account">アカウント</label>
            <select id="fw-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">アカウントを選ぶ…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle}（現在 {fullCount(a.followers)}）
                </option>
              ))}
            </select>
            <p className="hint">
              1日1回記録し、アカウントごとに最大400日分保存します。記録されなかった日をまたぐ区間は破線で表示します。
            </p>
          </div>
        </div>
      </section>

      {accountId && last90.length > 0 && (
        <FollowerChart rows={last90} accountHandle={account?.handle ?? ''} />
      )}
      {accountId && last90.length === 0 && (
        <p className="faded">このアカウントのフォロワー履歴はまだありません。アカウントチェックを実行すると記録されます。</p>
      )}
    </div>
  );
}

function FollowerChart({
  rows,
  accountHandle,
}: {
  rows: { date: string; followers: number }[];
  accountHandle: string;
}) {
  const W = 640;
  const H = 220;
  const PAD = { l: 56, r: 12, t: 12, b: 26 };
  const values = rows.map((r) => r.followers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const lo = Math.max(0, min - span * 0.15);
  const hi = max + span * 0.15;

  // Build one continuous x-axis across the date range (missing days
  // occupy space, so gaps become visible dashed segments).
  const start = new Date(`${rows[0].date}T00:00:00`);
  const end = new Date(`${rows[rows.length - 1].date}T00:00:00`);
  const dayCount = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400_000));
  const x = (date: string) =>
    PAD.l + ((new Date(`${date}T00:00:00`).getTime() - start.getTime()) / 86400_000 / dayCount) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  // Split into runs of consecutive days: solid within a run, dashed
  // across a gap (§12-3). Gap detection comes from lib/analytics
  // followerTrend so the chart and the trend table agree.
  const points = followerTrend(rows);
  const runs: { date: string; followers: number }[][] = [];
  for (const p of points) {
    if (p.gap || runs.length === 0) runs.push([{ date: p.date, followers: p.followers }]);
    else runs[runs.length - 1].push({ date: p.date, followers: p.followers });
  }

  const gapCount = runs.length - 1;
  const last = rows[rows.length - 1];
  const first = rows[0];
  const change = last.followers - first.followers;

  return (
    <section className="panel" style={{ marginTop: 12 }}>
      <h3 className="panel-title" style={{ marginTop: 0 }}>
        @{accountHandle}・直近{rows.length}日
      </h3>
      <p className="faded" style={{ fontSize: 13, marginTop: 0 }}>
        {first.date}：{fullCount(first.followers)} → {last.date}：{fullCount(last.followers)}
        （{change >= 0 ? '+' : ''}{fullCount(change)}）
        {gapCount > 0 && `・記録のない日が${gapCount}か所あり、破線で表示しています`}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="フォロワー数の推移グラフ">
        {[0, 0.5, 1].map((f) => {
          const v = Math.round(lo + (hi - lo) * f);
          const yy = y(v);
          return (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} stroke="var(--c-line)" strokeWidth={1} />
              <text x={PAD.l - 8} y={yy + 4} textAnchor="end" fontSize={11} fill="var(--c-faded)">
                {fullCount(v)}
              </text>
            </g>
          );
        })}
        {runs.map((run, ri) => {
          const points = run.map((r) => `${x(r.date)},${y(r.followers)}`).join(' ');
          return (
            <polyline
              key={ri}
              points={points}
              fill="none"
              stroke="var(--c-amber)"
              strokeWidth={2}
              strokeDasharray={run.length === 1 ? '3 3' : undefined}
            />
          );
        })}
        {/* Dashed connectors across gaps */}
        {runs.slice(1).map((run, i) => {
          const prev = runs[i][runs[i].length - 1];
          const next = run[0];
          return (
            <line
              key={`gap-${i}`}
              x1={x(prev.date)}
              y1={y(prev.followers)}
              x2={x(next.date)}
              y2={y(next.followers)}
              stroke="var(--c-amber)"
              strokeWidth={2}
              strokeDasharray="4 4"
              opacity={0.55}
            />
          );
        })}
        {rows.map((r) => (
          <circle key={r.date} cx={x(r.date)} cy={y(r.followers)} r={2.5} fill="var(--c-amber)" />
        ))}
        <text x={PAD.l} y={H - 6} fontSize={11} fill="var(--c-faded)">{first.date}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize={11} fill="var(--c-faded)">{last.date}</text>
      </svg>
    </section>
  );
}
