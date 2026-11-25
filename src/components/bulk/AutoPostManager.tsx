import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { AutoPostMode, AutoPostRule } from '../../db/types';
import {
  createAutoPostRule,
  deleteAutoPostRule,
  listAutoPostRuns,
  updateAutoPostRule,
} from '../../db/repository';
import { nextFireForRule } from '../../lib/autoPostEngine';
import { checkedAtLabel } from '../../lib/format';
import { AccountOrderPicker } from './AccountOrderPicker';
import { Button, Tooltip, useToast } from '../ui';

const MODE_LABELS: Record<AutoPostMode, string> = {
  random_window: '時間帯の中でランダム',
  fixed_times: '時刻を指定',
  weekly: '曜日投稿',
};

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

interface RuleFormState {
  name: string;
  enabled: boolean;
  accountIds: string[];
  templateId: string;
  mode: AutoPostMode;
  windowStart: string;
  windowEnd: string;
  postsPerDay: number;
  order: 'shuffle' | 'sequential';
  timesText: string;
  jitterMin: 0 | 5 | 15 | 30;
  weekdaySchedule: { weekday: number; time: string }[];
  mediaMode: 'random' | 'all';
  mediaRandomCount: number;
  skipIfSearchBan: boolean;
}

const EMPTY_FORM: RuleFormState = {
  name: '',
  enabled: true,
  accountIds: [],
  templateId: '',
  mode: 'random_window',
  windowStart: '07:00',
  windowEnd: '23:00',
  postsPerDay: 3,
  order: 'shuffle',
  timesText: '09:00\n18:00',
  jitterMin: 15,
  weekdaySchedule: [{ weekday: 5, time: '19:00' }],
  mediaMode: 'all',
  mediaRandomCount: 4,
  skipIfSearchBan: false,
};

/**
 * Auto-post rule manager (research §6-6), shown as the 4th tab of
 * the bulk-post page. Rules run only while the app is open; the
 * engine ticks every 30 s (see useScheduledEngines).
 */
export function AutoPostManager() {
  const toast = useToast();
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], []);
  const rules = useLiveQuery(() => db.autoPostRules.orderBy('createdAt').toArray(), [], []);
  const runs = useLiveQuery(() => listAutoPostRuns(50), [], []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [nextFires, setNextFires] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const rule of rules ?? []) {
        if (!rule.enabled) continue;
        const slot = await nextFireForRule(rule);
        if (slot) next[rule.id] = slot.label;
      }
      if (!cancelled) setNextFires(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [rules]);

  const startEdit = (rule?: AutoPostRule) => {
    if (rule) {
      setEditingId(rule.id);
      setForm({
        name: rule.name,
        enabled: rule.enabled,
        accountIds: [...rule.accountIds],
        templateId: rule.templateId,
        mode: rule.mode,
        windowStart: rule.windowStart ?? '07:00',
        windowEnd: rule.windowEnd ?? '23:00',
        postsPerDay: rule.postsPerDay ?? 3,
        order: rule.order ?? 'shuffle',
        timesText: (rule.times ?? []).join('\n'),
        jitterMin: rule.jitterMin ?? 15,
        weekdaySchedule: (rule.weekdaySchedule ?? []).map((s) => ({ ...s })),
        mediaMode: rule.mediaMode ?? 'all',
        mediaRandomCount: rule.mediaRandomCount ?? 4,
        skipIfSearchBan: rule.skipIfSearchBan ?? false,
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
    if (form.accountIds.length === 0) {
      toast.push('対象アカウントを1つ以上選んでください', 'err');
      return;
    }
    if (!form.templateId) {
      toast.push('テンプレートを選んでください', 'err');
      return;
    }
    const times = form.timesText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (form.mode === 'fixed_times' && times.length === 0) {
      toast.push('投稿時刻を1つ以上入力してください', 'err');
      return;
    }
    if (form.mode === 'fixed_times' && times.length > 48) {
      toast.push('時刻指定は48件までです', 'err');
      return;
    }
    if (form.postsPerDay > 20) {
      if (!window.confirm('1日20回を超える設定です。本当に保存しますか？')) return;
    }
    const input = {
      name: form.name.trim(),
      enabled: form.enabled,
      accountIds: form.accountIds,
      templateId: form.templateId,
      mode: form.mode,
      windowStart: form.mode === 'random_window' ? form.windowStart : undefined,
      windowEnd: form.mode === 'random_window' ? form.windowEnd : undefined,
      postsPerDay: form.mode === 'random_window' ? form.postsPerDay : undefined,
      order: form.mode === 'random_window' ? form.order : undefined,
      times: form.mode === 'fixed_times' ? times : undefined,
      jitterMin: form.mode === 'fixed_times' ? form.jitterMin : undefined,
      weekdaySchedule: form.mode === 'weekly' ? form.weekdaySchedule : undefined,
      mediaMode: form.mediaMode,
      mediaRandomCount: form.mediaRandomCount,
      skipIfSearchBan: form.skipIfSearchBan,
    };
    try {
      if (editingId) {
        await updateAutoPostRule(editingId, input);
        toast.push('自動投稿ルールを更新しました', 'ok');
      } else {
        await createAutoPostRule(input);
        toast.push('自動投稿ルールを作成しました', 'ok');
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch {
      toast.push('ルールの保存に失敗しました', 'err');
    }
  };

  const templateTitle = (id: string) => {
    const t = (templates ?? []).find((x) => x.id === id);
    return t ? `No.${t.no} ${t.title || '（無題）'}` : '—';
  };

  return (
    <div>
      <section className="panel">
        <h2 className="panel-title">
          自動投稿{' '}
          <Tooltip label="アプリを開いている間だけ動作します。予定時刻を15分以上過ぎた投稿はスキップします。アカウントをまたいだ投稿は60秒以上（＋0〜30秒のランダム）空けます。">
            <span aria-hidden="true">？</span>
          </Tooltip>
        </h2>
        <p className="dim" style={{ fontSize: 12.5 }}>
          エンジン状態: 稼働中（30秒ごとに確認）
          {(rules ?? []).filter((r) => r.enabled).length === 0 && '・有効なルールがありません'}
        </p>
      </section>

      <h2 className="section-title">{editingId ? 'ルールを編集' : 'ルールを新規作成'}</h2>
      <section className="panel">
        <div className="form-row">
          <div className="field">
            <label htmlFor="ap-name">ルール名</label>
            <input id="ap-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例：朝のあいさつ" />
          </div>
          <div className="field">
            <label htmlFor="ap-template">テンプレート</label>
            <select id="ap-template" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })}>
              <option value="">テンプレートを選ぶ…</option>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  No.{t.no} {t.title || '（無題）'}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>投稿条件</label>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            {(Object.keys(MODE_LABELS) as AutoPostMode[]).map((mode) => (
              <label key={mode} className="radio-label">
                <input type="radio" name="ap-mode" checked={form.mode === mode} onChange={() => setForm({ ...form, mode })} />
                {MODE_LABELS[mode]}
              </label>
            ))}
          </div>
        </div>

        {form.mode === 'random_window' && (
          <div className="form-row">
            <div className="field">
              <label htmlFor="ap-start">時間帯（開始）</label>
              <input id="ap-start" type="time" value={form.windowStart} onChange={(e) => setForm({ ...form, windowStart: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ap-end">時間帯（終了）</label>
              <input id="ap-end" type="time" value={form.windowEnd} onChange={(e) => setForm({ ...form, windowEnd: e.target.value })} />
              <p className="hint">終了が開始より早いときは翌日のその時刻まで。</p>
            </div>
            <div className="field">
              <label htmlFor="ap-per-day">1日の回数</label>
              <input id="ap-per-day" type="number" min={1} max={48} value={form.postsPerDay} onChange={(e) => setForm({ ...form, postsPerDay: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
            <div className="field">
              <label htmlFor="ap-order">順番</label>
              <select id="ap-order" value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value as 'shuffle' | 'sequential' })}>
                <option value="shuffle">シャッフルして一巡</option>
                <option value="sequential">登録順に一巡</option>
              </select>
            </div>
          </div>
        )}

        {form.mode === 'fixed_times' && (
          <div className="form-row">
            <div className="field">
              <label htmlFor="ap-times">投稿時刻（1行に1件・最大48件）</label>
              <textarea id="ap-times" rows={4} value={form.timesText} onChange={(e) => setForm({ ...form, timesText: e.target.value })} placeholder={'09:00\n18:00'} />
            </div>
            <div className="field">
              <label htmlFor="ap-jitter">揺らぎ</label>
              <select id="ap-jitter" value={form.jitterMin} onChange={(e) => setForm({ ...form, jitterMin: Number(e.target.value) as 0 | 5 | 15 | 30 })}>
                <option value={0}>なし</option>
                <option value={5}>±5分</option>
                <option value={15}>±15分</option>
                <option value={30}>±30分</option>
              </select>
            </div>
          </div>
        )}

        {form.mode === 'weekly' && (
          <div className="field">
            <label>曜日と時刻</label>
            {form.weekdaySchedule.map((entry, i) => (
              <div key={i} className="poll-row">
                <select
                  value={entry.weekday}
                  onChange={(e) => setForm({ ...form, weekdaySchedule: form.weekdaySchedule.map((s, j) => (j === i ? { ...s, weekday: Number(e.target.value) } : s)) })}
                  aria-label="曜日"
                >
                  {WEEKDAYS.map((label, w) => (
                    <option key={w} value={w}>{label}曜日</option>
                  ))}
                </select>
                <input
                  type="time" value={entry.time}
                  onChange={(e) => setForm({ ...form, weekdaySchedule: form.weekdaySchedule.map((s, j) => (j === i ? { ...s, time: e.target.value } : s)) })}
                  aria-label="時刻"
                />
                <span className="faded" style={{ fontSize: 12 }}>±5分の揺らぎ</span>
                <Button small variant="ghost" onClick={() => setForm({ ...form, weekdaySchedule: form.weekdaySchedule.filter((_, j) => j !== i) })} aria-label="この曜日を削除">
                  ✕
                </Button>
              </div>
            ))}
            <Button small onClick={() => setForm({ ...form, weekdaySchedule: [...form.weekdaySchedule, { weekday: 1, time: '12:00' }] })}>
              ＋ 曜日を追加
            </Button>
          </div>
        )}

        <div className="form-row">
          <div className="field">
            <label htmlFor="ap-media">画像・動画の件数</label>
            <select id="ap-media" value={form.mediaMode} onChange={(e) => setForm({ ...form, mediaMode: e.target.value as 'random' | 'all' })}>
              <option value="all">すべて（最大20件）</option>
              <option value="random">ランダムに選ぶ</option>
            </select>
            {form.mediaMode === 'random' && (
              <input
                type="number" min={1} max={20} value={form.mediaRandomCount}
                onChange={(e) => setForm({ ...form, mediaRandomCount: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })}
                aria-label="ランダムに選ぶ件数" style={{ marginTop: 6 }}
              />
            )}
          </div>
          <div className="field">
            <label>サーチバン連動</label>
            <label className="radio-label" style={{ paddingTop: 8 }}>
              <input type="checkbox" checked={form.skipIfSearchBan} onChange={(e) => setForm({ ...form, skipIfSearchBan: e.target.checked })} />
              24時間以内に非表示判定のアカウントは投稿を見送る
            </label>
          </div>
        </div>

        <h3 className="mini-title">対象アカウント</h3>
        {accounts === undefined ? (
          <p className="faded">読み込み中…</p>
        ) : (
          <AccountOrderPicker accounts={accounts} value={form.accountIds} onChange={(ids) => setForm({ ...form, accountIds: ids })} />
        )}

        <div className="toolbar" style={{ marginTop: 12 }}>
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
        <p className="faded">自動投稿ルールはまだありません。</p>
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
                  {MODE_LABELS[rule.mode]}・{templateTitle(rule.templateId)}・{rule.accountIds.length}件のアカウント
                </span>
                <div className="faded" style={{ fontSize: 12.5 }}>
                  {rule.enabled && nextFires[rule.id]
                    ? `次回予定: ${nextFires[rule.id]}`
                    : rule.enabled
                      ? '次回予定: —'
                      : '停止中'}
                  {rule.skipIfSearchBan ? '・サーチバン連動あり' : ''}
                </div>
              </span>
              <span className="row-actions">
                <Button small variant="ghost" onClick={() => void updateAutoPostRule(rule.id, { enabled: !rule.enabled })}>
                  {rule.enabled ? '停止' : '再開'}
                </Button>
                <Button small onClick={() => startEdit(rule)}>編集</Button>
                <Button
                  small
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`ルール「${rule.name}」を削除しますか？`)) void deleteAutoPostRule(rule.id);
                  }}
                >
                  削除
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">実行履歴</h2>
      {(runs ?? []).length === 0 ? (
        <p className="faded">自動投稿の実行履歴はまだありません。</p>
      ) : (
        <div className="ledger-simple">
          {(runs ?? []).map((run) => (
            <div key={run.id} className="simple-row">
              <span className={`badge ${run.status === 'done' ? 'st-logged_in' : run.status === 'failed' ? 'st-frozen' : 'plain'}`}>
                {run.status === 'done' ? '投稿済み' : run.status === 'failed' ? '失敗' : 'スキップ'}
              </span>
              <span className="grow">
                <strong>{run.ruleName}</strong>{' '}
                <span className="mono faded" style={{ fontSize: 12 }}>
                  {run.accountId ? `@${accounts?.find((a) => a.id === run.accountId)?.handle ?? '—'}` : ''}
                </span>
                {run.reason && <div className="faded" style={{ fontSize: 12.5 }}>{run.reason}</div>}
                {run.postUrl && <div className="mono faded" style={{ fontSize: 12 }}>{run.postUrl}</div>}
                <div className="faded mono" style={{ fontSize: 12 }}>{checkedAtLabel(run.at)}</div>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
