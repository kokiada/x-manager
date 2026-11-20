import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { AutoActionRule, BulkActionKind } from '../db/types';
import {
  createAutoActionRule,
  deleteAutoActionRule,
  listAutoActionEvents,
  startOfDay,
  updateAutoActionRule,
} from '../db/repository';
import { runBulkAction, type RandomRange } from '../lib/bulkActionService';
import { runAutoActionCycle } from '../lib/autoActionEngine';
import { AccountOrderPicker } from '../components/bulk/AccountOrderPicker';
import { Button, useToast } from '../components/ui';
import { checkedAtLabel } from '../lib/format';

type Tab = 'bulk' | 'rules' | 'feed';

const KIND_LABELS: Record<BulkActionKind, string> = {
  like: 'いいね',
  repost: 'リポスト',
  bookmark: 'ブックマーク',
};

const ACTION_KIND_LABELS: Record<string, string> = {
  like: 'いいね',
  repost: 'リポスト',
  bookmark: 'ブックマーク',
  reply: 'リプライ',
};

export function BulkAction() {
  const [tab, setTab] = useState<Tab>('bulk');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">05</span>一括操作
          </h1>
          <p className="page-lede">
            ポストへのいいね・リポスト・ブックマークの一括実行と、条件で自動実行する自動操作ルール（§7）。
          </p>
        </div>
      </div>

      <div className="view-tabs" role="tablist" aria-label="一括操作の表示切替">
        {(
          [
            ['bulk', '投稿の一括操作'],
            ['rules', '自動操作ルール'],
            ['feed', '活動フィード'],
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

      {tab === 'bulk' && <BulkActionTab />}
      {tab === 'rules' && <AutoActionRulesTab />}
      {tab === 'feed' && <ActivityFeedTab />}
    </div>
  );
}

/* --------------------------- manual bulk action --------------------------- */

function BulkActionTab() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const history = useLiveQuery(
    () => db.bulkActions.orderBy('createdAt').reverse().limit(10).toArray(),
    [],
    [],
  );

  const [targetsText, setTargetsText] = useState('');
  const [kind, setKind] = useState<BulkActionKind>('like');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [queueSequential, setQueueSequential] = useState(false);
  const [ranges, setRanges] = useState<RandomRange[]>([]);
  const [useRandom, setUseRandom] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef<AbortController | null>(null);

  const targets = useMemo(
    () => targetsText.split('\n').map((s) => s.trim()).filter(Boolean),
    [targetsText],
  );
  const orderedPool = useMemo(() => {
    const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
    return accountIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
  }, [accounts, accountIds]);

  const run = async () => {
    if (targets.length === 0) {
      toast.push('対象ポストのURLを入力してください', 'err');
      return;
    }
    if (accountIds.length === 0) {
      toast.push('対象アカウントを選択してください', 'err');
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setProgress({ done: 0, total: 0 });
    try {
      const job = await runBulkAction({
        kind,
        targets,
        accountIds,
        queueSequential,
        randomRanges: useRandom ? ranges : undefined,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const okCount = job.entries.filter((e) => e.status === 'done').length;
      toast.push(
        job.status === 'cancelled'
          ? '一括操作をキャンセルしました'
          : `一括操作が完了しました（${okCount}/${job.entries.length}件成功）`,
        job.status === 'done' ? 'ok' : 'info',
      );
    } catch (err) {
      toast.push(err instanceof Error ? err.message : '一括操作に失敗しました', 'err');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const latestJob = (history ?? [])[0];
  const runningJob = latestJob?.status === 'running' ? latestJob : null;

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">投稿の一括操作（§7-1）</h2>
        <div className="form-row">
          <div className="field">
            <label htmlFor="ba-targets">対象ポストのURL（1行に1件）</label>
            <textarea
              id="ba-targets"
              rows={4}
              value={targetsText}
              onChange={(e) => setTargetsText(e.target.value)}
              placeholder={'https://x.com/xxx/status/123...\nhttps://x.com/yyy/status/456...'}
              disabled={running}
            />
            <p className="hint">対象は複数指定できます。投稿者本人のアカウントは自動で除外されます。</p>
          </div>
          <div className="field">
            <label>操作の種類</label>
            <div className="toolbar" style={{ marginBottom: 6 }}>
              {(Object.keys(KIND_LABELS) as BulkActionKind[]).map((k) => (
                <label key={k} className="radio-label">
                  <input type="radio" name="ba-kind" checked={kind === k} onChange={() => setKind(k)} disabled={running} />
                  {KIND_LABELS[k]}
                </label>
              ))}
            </div>
            <label className="radio-label">
              <input
                type="checkbox"
                checked={queueSequential}
                onChange={(e) => setQueueSequential(e.target.checked)}
                disabled={running}
              />
              1件ずつキューで処理（1件目が全アカウントで終わってから2件目へ）
            </label>
            <label className="radio-label">
              <input type="checkbox" checked={useRandom} onChange={(e) => setUseRandom(e.target.checked)} disabled={running} />
              ランダムに選出（下の枠からランダムに選んだアカウントで実行）
            </label>
          </div>
        </div>

        {useRandom && (
          <div className="field">
            <label>ランダム選出の枠（並び順の位置は0から数えます）</label>
            {ranges.map((range, i) => (
              <div key={i} className="poll-row">
                <span className="mono" style={{ fontSize: 12, paddingTop: 8 }}>枠{i + 1}</span>
                <input
                  type="number" min={0} max={Math.max(0, orderedPool.length - 1)} value={range.start}
                  onChange={(e) => setRanges((prev) => prev.map((r, j) => (j === i ? { ...r, start: Number(e.target.value) || 0 } : r)))}
                  aria-label="開始位置" style={{ width: 90 }}
                />
                <span className="faded">〜</span>
                <input
                  type="number" min={0} max={Math.max(0, orderedPool.length - 1)} value={range.end}
                  onChange={(e) => setRanges((prev) => prev.map((r, j) => (j === i ? { ...r, end: Number(e.target.value) || 0 } : r)))}
                  aria-label="終了位置" style={{ width: 90 }}
                />
                <span className="faded">から</span>
                <input
                  type="number" min={1} value={range.count}
                  onChange={(e) => setRanges((prev) => prev.map((r, j) => (j === i ? { ...r, count: Math.max(1, Number(e.target.value) || 1) } : r)))}
                  aria-label="選出数" style={{ width: 80 }}
                />
                <span className="faded">件</span>
                <Button small variant="ghost" onClick={() => setRanges((prev) => prev.filter((_, j) => j !== i))} aria-label="この枠を削除">
                  ✕
                </Button>
              </div>
            ))}
            <Button
              small
              onClick={() => setRanges((prev) => [...prev, { start: 0, end: Math.max(0, orderedPool.length - 1), count: 1 }])}
            >
              ＋ 枠を追加
            </Button>
            <p className="hint">ロック・凍結・未ログインのアカウントは選ばれません。</p>
          </div>
        )}

        <h3 className="mini-title">対象アカウント（上から順に実行）</h3>
        {accounts === undefined ? (
          <p className="faded">読み込み中…</p>
        ) : (
          <AccountOrderPicker accounts={accounts} value={accountIds} onChange={setAccountIds} disabled={running} />
        )}

        {(running || (runningJob && progress.total > 0)) && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-line">
              <span>実行中</span>
              <span className="mono">{progress.done}/{progress.total}</span>
            </div>
          </div>
        )}

        <div className="toolbar" style={{ marginTop: 12 }}>
          <Button variant="primary" onClick={run} disabled={running}>
            {running ? '実行中…' : `${KIND_LABELS[kind]}を一括実行`}
          </Button>
          {running && (
            <Button variant="danger" onClick={() => abortRef.current?.abort()}>
              キャンセル
            </Button>
          )}
          <span className="faded" style={{ fontSize: 12.5 }}>
            対象 {targets.length}件 × アカウント {orderedPool.length}件
          </span>
        </div>
      </section>

      {latestJob && latestJob.status !== 'running' && (
        <>
          <h2 className="section-title">直近の実行結果</h2>
          <div className="ledger-simple">
            {latestJob.entries.map((e, i) => (
              <div key={i} className="simple-row">
                <span className={`badge ${e.status === 'done' ? 'st-logged_in' : e.status === 'failed' ? 'st-frozen' : 'plain'}`}>
                  {e.status === 'done' ? '完了' : e.status === 'failed' ? '失敗' : 'スキップ'}
                </span>
                <span className="grow">
                  <strong>@{e.handle}</strong>{' '}
                  <span className="mono faded" style={{ fontSize: 12 }}>{e.targetUrl}</span>
                  {e.error && <div className="faded" style={{ fontSize: 12.5 }}>{e.error}</div>}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="section-title">実行履歴</h2>
      {(history ?? []).length === 0 ? (
        <p className="faded">まだ一括操作の履歴がありません。</p>
      ) : (
        <div className="ledger-simple">
          {(history ?? []).map((job) => (
            <div key={job.id} className="simple-row">
              <span className="grow">
                <strong>{KIND_LABELS[job.kind]}</strong> {job.targets.length}件のポスト × {job.accountIds.length}件のアカウント
                <div className="faded mono" style={{ fontSize: 12 }}>
                  {checkedAtLabel(job.createdAt)}・{job.status}・
                  成功 {job.entries.filter((e) => e.status === 'done').length}/{job.entries.length}
                </div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------- auto-action rules --------------------------- */

interface RuleFormState {
  name: string;
  enabled: boolean;
  trigger: 'on_post' | 'on_traction';
  triggerAccountIds: string[];
  actionKinds: string[];
  replyTemplateIds: string[];
  kindFilter: 'any' | 'image' | 'video' | 'text';
  keywords: string;
  actingAccountIds: string[];
  actingAll: boolean;
  dailyCap: number;
}

const EMPTY_FORM: RuleFormState = {
  name: '',
  enabled: true,
  trigger: 'on_post',
  triggerAccountIds: [],
  actionKinds: ['like'],
  replyTemplateIds: [],
  kindFilter: 'any',
  keywords: '',
  actingAccountIds: [],
  actingAll: true,
  dailyCap: 50,
};

function AutoActionRulesTab() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], []);
  const rules = useLiveQuery(() => db.autoActionRules.orderBy('createdAt').toArray(), [], []);
  const eventsToday = useLiveQuery(
    () => db.autoActionEvents.where('at').aboveOrEqual(startOfDay(Date.now())).toArray(),
    [],
    [],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [simulating, setSimulating] = useState(false);

  const doneToday = (eventsToday ?? []).filter((e) => e.status === 'done').length;
  const enabledRules = (rules ?? []).filter((r) => r.enabled);
  const cap = enabledRules.length > 0 ? Math.min(...enabledRules.map((r) => r.dailyCap)) : 50;

  const startEdit = (rule?: AutoActionRule) => {
    if (rule) {
      setEditingId(rule.id);
      setForm({
        name: rule.name,
        enabled: rule.enabled,
        trigger: rule.trigger,
        triggerAccountIds: [...rule.triggerAccountIds],
        actionKinds: [...rule.actionKinds],
        replyTemplateIds: [...(rule.replyTemplateIds ?? [])],
        kindFilter: rule.kindFilter,
        keywords: (rule.keywords ?? []).join(', '),
        actingAccountIds: [...rule.actingAccountIds],
        actingAll: rule.actingAccountIds.includes('all'),
        dailyCap: rule.dailyCap,
      });
    } else {
      setEditingId(null);
      setForm(EMPTY_FORM);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.push('ルール名を入力してください', 'err');
      return;
    }
    if (form.triggerAccountIds.length === 0) {
      toast.push('反応するアカウント（投稿元）を1つ以上選んでください', 'err');
      return;
    }
    if (form.actionKinds.length === 0) {
      toast.push('実行する操作を1つ以上選んでください', 'err');
      return;
    }
    const input = {
      name: form.name.trim(),
      enabled: form.enabled,
      trigger: form.trigger,
      triggerAccountIds: form.triggerAccountIds,
      actionKinds: form.actionKinds as AutoActionRule['actionKinds'],
      replyTemplateIds: form.replyTemplateIds,
      kindFilter: form.kindFilter,
      keywords: form.keywords.split(',').map((s) => s.trim()).filter(Boolean),
      actingAccountIds: form.actingAll ? ['all'] : form.actingAccountIds,
      dailyCap: Math.max(1, form.dailyCap),
    };
    try {
      if (editingId) {
        await updateAutoActionRule(editingId, input);
        toast.push('ルールを更新しました', 'ok');
      } else {
        await createAutoActionRule(input);
        toast.push('ルールを作成しました', 'ok');
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch {
      toast.push('ルールの保存に失敗しました', 'err');
    }
  };

  const simulate = async () => {
    if (enabledRules.length === 0) {
      toast.push('有効なルールがありません。まずルールを作成してください', 'err');
      return;
    }
    setSimulating(true);
    try {
      const events = await runAutoActionCycle({ probability: 1 });
      if (events.length === 0) {
        toast.push('今回は反応する投稿がありませんでした（もう一度お試しください）', 'info');
      } else {
        const done = events.filter((e) => e.status === 'done').length;
        toast.push(`投稿をシミュレーションしました（${done}件の操作を実行）`, 'ok');
      }
    } finally {
      setSimulating(false);
    }
  };

  const toggleCheck = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">1日の上限（全ルール共通）</h2>
        <div className="progress-line">
          <span>本日の実行数</span>
          <span className="mono">
            {doneToday} / {cap}件
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--c-line)', borderRadius: 3, overflow: 'hidden', marginTop: 6 }}>
          <div
            style={{ width: `${Math.min(100, (doneToday / cap) * 100)}%`, height: '100%', background: doneToday >= cap ? 'var(--c-warn)' : 'var(--c-amber)' }}
          />
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          上限は有効なルールの中で最も小さい値が使われます。実行待ち分も含めて数えます（§7-2）。
        </p>
        <div className="toolbar">
          <Button onClick={simulate} disabled={simulating}>
            {simulating ? 'シミュレーション中…' : '投稿をシミュレーション'}
          </Button>
          <span className="faded" style={{ fontSize: 12.5 }}>
            トリガーアカウントの新規投稿を模擬して、ルールを1回評価します
          </span>
        </div>
      </section>

      <h2 className="section-title">{editingId ? 'ルールを編集' : 'ルールを新規作成'}</h2>
      <section className="panel">
        <div className="form-row">
          <div className="field">
            <label htmlFor="ar-name">ルール名</label>
            <input id="ar-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例：メイン投稿の拡散" />
          </div>
          <div className="field">
            <label htmlFor="ar-cap">1日の上限（件）</label>
            <input
              id="ar-cap" type="number" min={1} value={form.dailyCap}
              onChange={(e) => setForm({ ...form, dailyCap: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field">
            <label>反応するタイミング</label>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <label className="radio-label">
                <input type="radio" name="ar-trigger" checked={form.trigger === 'on_post'} onChange={() => setForm({ ...form, trigger: 'on_post' })} />
                投稿したとき
              </label>
              <label className="radio-label">
                <input type="radio" name="ar-trigger" checked={form.trigger === 'on_traction'} onChange={() => setForm({ ...form, trigger: 'on_traction' })} />
                投稿が伸びたとき（24時間時点の中央値の1.5倍以上）
              </label>
            </div>
          </div>
          <div className="field">
            <label>投稿の種類</label>
            <select value={form.kindFilter} onChange={(e) => setForm({ ...form, kindFilter: e.target.value as RuleFormState['kindFilter'] })}>
              <option value="any">すべて</option>
              <option value="image">画像付き</option>
              <option value="video">動画付き</option>
              <option value="text">テキストのみ</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>反応するアカウント（投稿元）</label>
          <div className="pick-list">
            {(accounts ?? []).map((a) => (
              <label key={a.id} className="pick-row">
                <input
                  type="checkbox"
                  checked={form.triggerAccountIds.includes(a.id)}
                  onChange={() => setForm({ ...form, triggerAccountIds: toggleCheck(form.triggerAccountIds, a.id) })}
                />
                <span className="pick-main">
                  <strong>{a.displayName}</strong>{' '}
                  <span className="mono faded" style={{ fontSize: 12 }}>@{a.handle}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <label>実行する操作</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            {Object.keys(ACTION_KIND_LABELS).map((k) => (
              <label key={k} className="radio-label">
                <input
                  type="checkbox"
                  checked={form.actionKinds.includes(k)}
                  onChange={() => setForm({ ...form, actionKinds: toggleCheck(form.actionKinds, k) })}
                />
                {ACTION_KIND_LABELS[k]}
              </label>
            ))}
          </div>
        </div>
        {form.actionKinds.includes('reply') && (
          <div className="field">
            <label>リプライ用テンプレート（反応アカウント数以上が必要です）</label>
            <div className="pick-list">
              {(templates ?? []).map((t) => (
                <label key={t.id} className="pick-row">
                  <input
                    type="checkbox"
                    checked={form.replyTemplateIds.includes(t.id)}
                    onChange={() => setForm({ ...form, replyTemplateIds: toggleCheck(form.replyTemplateIds, t.id) })}
                  />
                  <span className="pick-main">
                    <strong>No.{t.no} {t.title || '（無題）'}</strong>
                    <span className="faded" style={{ fontSize: 12.5, display: 'block' }}>{t.body.slice(0, 60)}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="form-row">
          <div className="field">
            <label htmlFor="ar-keywords">本文の語句（カンマ区切り・すべて含む場合のみ反応）</label>
            <input id="ar-keywords" type="text" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="例：試合, 勝利" />
          </div>
          <div className="field">
            <label>実行アカウント</label>
            <label className="radio-label">
              <input type="checkbox" checked={form.actingAll} onChange={(e) => setForm({ ...form, actingAll: e.target.checked })} />
              対象の全アカウント（投稿者・同一プロキシ・ロック等を除く）
            </label>
            {!form.actingAll && (
              <div className="pick-list" style={{ marginTop: 6 }}>
                {(accounts ?? []).map((a) => (
                  <label key={a.id} className="pick-row">
                    <input
                      type="checkbox"
                      checked={form.actingAccountIds.includes(a.id)}
                      onChange={() => setForm({ ...form, actingAccountIds: toggleCheck(form.actingAccountIds, a.id) })}
                    />
                    <span className="pick-main">
                      <strong>{a.displayName}</strong>{' '}
                      <span className="mono faded" style={{ fontSize: 12 }}>@{a.handle}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="toolbar">
          <label className="radio-label">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            このルールを有効にする
          </label>
          <span className="spacer" />
          {editingId && (
            <Button variant="ghost" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}>
              キャンセル
            </Button>
          )}
          <Button variant="primary" onClick={save}>
            {editingId ? 'ルールを更新' : 'ルールを作成'}
          </Button>
        </div>
      </section>

      <h2 className="section-title">ルール一覧</h2>
      {(rules ?? []).length === 0 ? (
        <p className="faded">ルールはまだありません。</p>
      ) : (
        <div className="ledger-simple">
          {(rules ?? []).map((rule) => (
            <div key={rule.id} className="simple-row">
              <span className={`badge ${rule.enabled ? 'st-logged_in' : 'plain'}`}>
                {rule.enabled ? '有効' : '停止中'}
              </span>
              <span className="grow">
                <strong>{rule.name}</strong>{' '}
                <span className="faded" style={{ fontSize: 12.5 }}>
                  {rule.trigger === 'on_post' ? '投稿したとき' : '投稿が伸びたとき'}・
                  {rule.actionKinds.map((k) => ACTION_KIND_LABELS[k]).join('・')}・上限{rule.dailyCap}件/日
                </span>
                <div className="faded" style={{ fontSize: 12.5 }}>
                  投稿元 {(rule.triggerAccountIds.map((id) => accounts?.find((a) => a.id === id)?.handle ?? '?').map((h) => `@${h}`).join(', ')) || '—'}
                </div>
              </span>
              <span className="row-actions">
                <Button
                  small
                  variant="ghost"
                  onClick={() => void updateAutoActionRule(rule.id, { enabled: !rule.enabled })}
                >
                  {rule.enabled ? '停止' : '再開'}
                </Button>
                <Button small onClick={() => startEdit(rule)}>編集</Button>
                <Button
                  small
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`ルール「${rule.name}」を削除しますか？`)) void deleteAutoActionRule(rule.id);
                  }}
                >
                  削除
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ activity feed ------------------------------ */

function ActivityFeedTab() {
  const events = useLiveQuery(() => listAutoActionEvents(100), [], []);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const handleOf = (id: string) => accounts?.find((a) => a.id === id)?.handle ?? '—';

  return (
    <div>
      <h2 className="section-title">活動フィード（最新100件）</h2>
      {(events ?? []).length === 0 ? (
        <div className="placeholder-box">
          <div className="ph-tag">EMPTY</div>
          <p style={{ marginBottom: 0 }}>
            自動操作の実行履歴はまだありません。「自動操作ルール」タブの「投稿をシミュレーション」で試せます。
          </p>
        </div>
      ) : (
        <div className="ledger-simple">
          {(events ?? []).map((e) => (
            <div key={e.id} className="simple-row">
              <span className={`badge ${e.status === 'done' ? 'st-logged_in' : e.status === 'failed' ? 'st-frozen' : 'plain'}`}>
                {e.status === 'done' ? '実行' : e.status === 'failed' ? '失敗' : 'スキップ'}
              </span>
              <span className="grow">
                <strong>{ACTION_KIND_LABELS[e.kind] ?? e.kind}</strong>{' '}
                <span className="faded" style={{ fontSize: 12.5 }}>
                  {e.ruleName}・@{e.authorHandle} の投稿へ
                  {e.actingAccountId ? `（@${handleOf(e.actingAccountId)}）` : ''}
                </span>
                <div className="mono faded" style={{ fontSize: 12 }}>{e.postUrl}</div>
                {e.reason && <div className="faded" style={{ fontSize: 12.5 }}>{e.reason}</div>}
                <div className="faded mono" style={{ fontSize: 12 }}>{checkedAtLabel(e.at)}</div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
