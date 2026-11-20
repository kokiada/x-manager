import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { AutomationRule, BulkActionKind } from '../db/types';
import { BULK_ACTION_LABELS } from '../db/types';
import { listActionJobs, listAutomationRules, updateAutomationRule, deleteAutomationRule } from '../db/repository';
import { createAndRunActionJob, UNACTABLE } from '../lib/actionService';
import { checkedAtLabel } from '../lib/format';
import { Button, Modal, useToast } from '../components/ui';
import { AutomationRuleForm } from '../components/AutomationRuleForm';

const ACTION_KINDS: BulkActionKind[] = ['like', 'repost', 'bookmark', 'follow'];

const ENTRY_LABEL: Record<string, string> = {
  pending: '待機中',
  running: '実行中',
  done: '完了',
  failed: '失敗',
  skipped: 'スキップ',
};

export function BulkAction() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const jobs = useLiveQuery(() => listActionJobs(10), [], undefined);
  const rules = useLiveQuery(() => listAutomationRules(), [], undefined);
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], []);

  const [kind, setKind] = useState<BulkActionKind>('like');
  const [targetsText, setTargetsText] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [intervalSec, setIntervalSec] = useState(3);
  const [queueOneByOne, setQueueOneByOne] = useState(true);
  const [running, setRunning] = useState(false);
  const [ruleModal, setRuleModal] = useState<{ rule?: AutomationRule; kind?: AutomationRule['kind'] } | null>(null);

  const usable = useMemo(
    () => (accounts ?? []).filter((a) => !UNACTABLE.has(a.status)),
    [accounts],
  );
  const targets = useMemo(
    () =>
      targetsText
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean),
    [targetsText],
  );

  const run = async () => {
    if (targets.length === 0) {
      toast.push('対象を1件以上入力してください', 'err');
      return;
    }
    if (selectedAccounts.length === 0) {
      toast.push('実行するアカウントを1つ以上選んでください', 'err');
      return;
    }
    setRunning(true);
    try {
      const job = await createAndRunActionJob({
        kind,
        targets,
        accountIds: selectedAccounts,
        intervalSec,
        queueOneByOne,
      });
      const done = job.entries.filter((e) => e.status === 'done').length;
      const failed = job.entries.filter((e) => e.status === 'failed').length;
      toast.push(
        `${BULK_ACTION_LABELS[kind]}を実行しました：完了 ${done}件／失敗 ${failed}件／スキップ ${
          job.entries.filter((e) => e.status === 'skipped').length
        }件`,
        failed > 0 ? 'info' : 'ok',
      );
    } catch {
      toast.push('一括操作に失敗しました', 'err');
    } finally {
      setRunning(false);
    }
  };

  const latestJob = jobs?.[0];
  const autoPostRules = (rules ?? []).filter((r) => r.kind === 'auto_post');
  const autoActionRules = (rules ?? []).filter((r) => r.kind === 'auto_action');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">05</span>一括操作
          </h1>
          <p className="page-lede">
            特定のポストへのいいね・リポスト・ブックマーク、指定アカウントへのフォローをまとめて実行します。自動操作ルールもここで管理します。
          </p>
        </div>
      </div>

      <h2 className="section-title">手動の一括実行</h2>
      <div className="toolbar" role="group" aria-label="操作の種類">
        {ACTION_KINDS.map((k) => (
          <Button
            key={k}
            small
            variant={kind === k ? 'primary' : 'default'}
            onClick={() => setKind(k)}
          >
            {BULK_ACTION_LABELS[k]}
          </Button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="bulk-targets">
          {kind === 'follow'
            ? 'フォロー対象のアカウント（@handle を1行に1件）'
            : '対象ポストのURL（1行に1件）'}
        </label>
        <textarea
          id="bulk-targets"
          rows={4}
          placeholder={
            kind === 'follow'
              ? '@kashima_soccer_jp\n@antlers_daily'
              : 'https://x.com/kashima_soccer_jp/status/1234567890'
          }
          value={targetsText}
          onChange={(e) => setTargetsText(e.target.value)}
        />
      </div>

      <div className="field">
        <label>実行するアカウント（ロック・凍結・未ログインは選べません）</label>
        <div className="pick-list">
          {usable.map((a) => (
            <label key={a.id} className="pick-row">
              <input
                type="checkbox"
                checked={selectedAccounts.includes(a.id)}
                onChange={(e) =>
                  setSelectedAccounts((prev) =>
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
          {usable.length === 0 && <p className="faded">実行できるアカウントがありません。</p>}
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="bulk-interval">アカウント間の間隔（秒）</label>
          <input
            id="bulk-interval"
            type="number"
            min={1}
            max={60}
            value={intervalSec}
            onChange={(e) => setIntervalSec(Math.max(1, Math.min(60, Number(e.target.value) || 3)))}
          />
        </div>
        <div className="field">
          <label className="radio-label">
            <input
              type="checkbox"
              checked={queueOneByOne}
              onChange={(e) => setQueueOneByOne(e.target.checked)}
            />
            1件ずつキューで処理（1件のポストを全アカウントで終えてから次へ）
          </label>
        </div>
      </div>

      <div className="toolbar">
        <Button variant="primary" onClick={run} disabled={running || targets.length === 0}>
          {running ? '実行中…' : `${BULK_ACTION_LABELS[kind]}を一括実行`}
        </Button>
        <span className="faded" style={{ fontSize: 12.5 }}>
          投稿したアカウント自身は自動で除外されます。短時間の大量実行はロックの原因になることがあります。
        </span>
      </div>

      {latestJob && (
        <>
          <h2 className="section-title">最新の実行</h2>
          <div className="job-card">
            <div className="job-head">
              <strong>
                {BULK_ACTION_LABELS[latestJob.kind]} ・ {checkedAtLabel(latestJob.startedAt)}
              </strong>
              <span
                className={`badge jb-${latestJob.status === 'done' ? 'done' : latestJob.status === 'partial' ? 'failed' : 'running'}`}
              >
                {latestJob.status === 'done'
                  ? '完了'
                  : latestJob.status === 'partial'
                    ? '一部失敗'
                    : latestJob.status === 'cancelled'
                      ? '中止'
                      : '実行中'}
              </span>
              <span className="spacer" />
              <span className="faded" style={{ fontSize: 12.5 }}>
                完了 {latestJob.entries.filter((e) => e.status === 'done').length} /{' '}
                {latestJob.entries.length}件
              </span>
            </div>
            <div className="job-entries">
              {latestJob.entries.map((e, i) => (
                <div key={`${e.accountId}-${e.target}-${i}`} className="entry-row">
                  <span className="grow">
                    <strong>@{e.handle}</strong>{' '}
                    <span className="mono faded" style={{ fontSize: 12 }}>{e.target}</span>
                    {e.error && <span className="faded"> — {e.error}</span>}
                  </span>
                  <span className={`badge jb-${e.status}`}>{ENTRY_LABEL[e.status]}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <h2 className="section-title">実行履歴</h2>
      {(jobs ?? []).slice(1).map((j) => (
        <div key={j.id} className="simple-row">
          <span className="grow">
            {BULK_ACTION_LABELS[j.kind]} ・ {checkedAtLabel(j.startedAt)}
            {j.ruleId ? '（自動操作）' : ''}
          </span>
          <span className="faded" style={{ fontSize: 12.5 }}>
            完了 {j.entries.filter((e) => e.status === 'done').length} / {j.entries.length}件
          </span>
        </div>
      ))}
      {(jobs ?? []).length <= 1 && <p className="faded">履歴はまだありません。</p>}

      <h2 className="section-title">自動投稿ルール</h2>
      <p className="faded" style={{ fontSize: 13 }}>
        テンプレートの投稿を決めた条件で繰り返し投稿します。アプリを開いている間だけ動きます。予定時刻を15分以上過ぎた投稿はスキップします。
      </p>
      <div className="toolbar">
        <Button onClick={() => setRuleModal({ kind: 'auto_post' })}>＋ 自動投稿ルールを作成</Button>
      </div>
      {autoPostRules.length === 0 && <p className="faded">自動投稿ルールはまだありません。</p>}
      {autoPostRules.map((r) => (
        <RuleRow key={r.id} rule={r} templates={templates ?? []} onEdit={() => setRuleModal({ rule: r })} />
      ))}

      <h2 className="section-title">自動操作ルール</h2>
      <p className="faded" style={{ fontSize: 13 }}>
        登録アカウントが投稿したとき、他の登録アカウントから自動でいいね・リポスト・ブックマーク・リプライします。投稿から6時間以内の投稿だけが対象です。
      </p>
      <div className="toolbar">
        <Button onClick={() => setRuleModal({ kind: 'auto_action' })}>＋ 自動操作ルールを作成</Button>
      </div>
      {autoActionRules.length === 0 && <p className="faded">自動操作ルールはまだありません。</p>}
      {autoActionRules.map((r) => (
        <RuleRow key={r.id} rule={r} templates={templates ?? []} onEdit={() => setRuleModal({ rule: r })} />
      ))}

      {ruleModal && (
        <Modal
          title={ruleModal.rule ? 'ルールを編集' : 'ルールを作成'}
          onClose={() => setRuleModal(null)}
        >
          <AutomationRuleForm
            rule={ruleModal.rule}
            defaultKind={ruleModal.kind ?? 'auto_post'}
            onDone={() => setRuleModal(null)}
          />
        </Modal>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  templates,
  onEdit,
}: {
  rule: AutomationRule;
  templates: { id: string; no: number; title: string }[];
  onEdit: () => void;
}) {
  const toast = useToast();
  const template = templates.find((t) => t.id === rule.templateId);
  return (
    <div className="simple-row">
      <span className="grow">
        <strong>{rule.name}</strong>{' '}
        <span className="badge plain">{rule.kind === 'auto_post' ? '自動投稿' : '自動操作'}</span>
        {template && <span className="faded"> ・ テンプレート No.{template.no}「{template.title}」</span>}
        {rule.mode === 'window' && (
          <span className="faded"> ・ {rule.windowStart}〜{rule.windowEnd}に{rule.postsPerDay}回/日</span>
        )}
        {rule.mode === 'times' && <span className="faded"> ・ 毎日 {(rule.times ?? []).join(', ')}</span>}
        {rule.mode === 'weekly' && <span className="faded"> ・ 毎週 {(rule.times ?? []).join(', ')}</span>}
        {rule.actionKinds && (
          <span className="faded"> ・ {rule.actionKinds.map((k) => BULK_ACTION_LABELS[k]).join('・')}</span>
        )}
        {rule.keyword && <span className="faded"> ・ 語句「{rule.keyword}」</span>}
        <span className="faded"> ・ 対象 {rule.accountIds.length}アカウント</span>
      </span>
      <label className="radio-label">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={async (e) => {
            await updateAutomationRule(rule.id, { enabled: e.target.checked });
            toast.push(e.target.checked ? 'ルールを有効化しました' : 'ルールを停止しました', 'ok');
          }}
        />
        有効
      </label>
      <Button small onClick={onEdit}>
        編集
      </Button>
      <Button
        small
        variant="danger"
        onClick={async () => {
          await deleteAutomationRule(rule.id);
          toast.push('ルールを削除しました', 'ok');
        }}
      >
        削除
      </Button>
    </div>
  );
}
