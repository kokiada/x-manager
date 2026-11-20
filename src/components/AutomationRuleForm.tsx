import { useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { AutomationRule, AutoPostMode, BulkActionKind } from '../db/types';
import { BULK_ACTION_LABELS } from '../db/types';
import { createAutomationRule, updateAutomationRule } from '../db/repository';
import { Button } from './ui';

const ACTION_KINDS: BulkActionKind[] = ['like', 'repost', 'bookmark', 'follow'];
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const JITTER_OPTIONS = [0, 5, 15, 30];

interface Props {
  rule?: AutomationRule;
  defaultKind: AutomationRule['kind'];
  onDone: () => void;
}

/**
 * Create / edit form for an automation rule. New rules take their kind
 * from defaultKind; editing keeps the rule's kind. Saves through the
 * repository so the rules list (useLiveQuery) refreshes by itself.
 */
export function AutomationRuleForm({ rule, defaultKind, onDone }: Props) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], []);

  const [kind] = useState<AutomationRule['kind']>(rule?.kind ?? defaultKind);
  const [name, setName] = useState(rule?.name ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [accountIds, setAccountIds] = useState<string[]>(rule?.accountIds ?? []);
  const [templateId, setTemplateId] = useState(rule?.templateId ?? '');
  const [mode, setMode] = useState<AutoPostMode>(rule?.mode ?? 'window');
  const [windowStart, setWindowStart] = useState(rule?.windowStart ?? '09:00');
  const [windowEnd, setWindowEnd] = useState(rule?.windowEnd ?? '21:00');
  const [postsPerDay, setPostsPerDay] = useState(rule?.postsPerDay ?? 3);
  const [timesText, setTimesText] = useState((rule?.times ?? []).join(', '));
  const [jitterMin, setJitterMin] = useState(rule?.jitterMin ?? 0);
  const [weekdays, setWeekdays] = useState<number[]>(rule?.weekdays ?? [1, 2, 3, 4, 5]);
  const [order, setOrder] = useState<'shuffle' | 'sequential'>(rule?.order ?? 'shuffle');
  const [skipSearchBanned, setSkipSearchBanned] = useState(rule?.skipSearchBanned ?? true);
  const [actionKinds, setActionKinds] = useState<BulkActionKind[]>(rule?.actionKinds ?? ['like']);
  const [keyword, setKeyword] = useState(rule?.keyword ?? '');
  const [dailyCap, setDailyCap] = useState(rule?.dailyCap ?? 20);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], id: T): T[] =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('ルール名を入力してください。');
      return;
    }
    if (accountIds.length === 0) {
      setError('実行するアカウントを1つ以上選んでください。');
      return;
    }
    if (kind === 'auto_post' && !templateId) {
      setError('投稿するテンプレートを選んでください。');
      return;
    }
    const times = timesText
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (times.some((t) => !/^\d{1,2}:\d{2}$/.test(t))) {
      setError('時刻は「HH:MM」形式で入力してください。');
      return;
    }
    if (times.length > 48) {
      setError('時刻は48件までにしてください。');
      return;
    }
    if (kind === 'auto_action' && actionKinds.length === 0) {
      setError('自動操作の種類を1つ以上選んでください。');
      return;
    }
    setSaving(true);
    try {
      const input = {
        kind,
        name: name.trim(),
        enabled,
        accountIds,
        templateId: templateId || undefined,
        mode,
        windowStart,
        windowEnd,
        postsPerDay: Math.max(1, postsPerDay),
        times,
        jitterMin,
        weekdays,
        order,
        skipSearchBanned,
        actionKinds,
        keyword: keyword.trim() || undefined,
        dailyCap: Math.max(1, dailyCap),
      };
      if (rule) {
        await updateAutomationRule(rule.id, input);
      } else {
        await createAutomationRule(input);
      }
      onDone();
    } catch {
      setError('保存に失敗しました。もう一度お試しください。');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="arf-name">ルール名</label>
          <input
            id="arf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="朝の自動投稿"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label>種類</label>
          <div>{kind === 'auto_post' ? '自動投稿' : '自動操作'}</div>
        </div>
      </div>

      <div className="form-row">
        <div className="field">
          <label htmlFor="arf-template">
            {kind === 'auto_post' ? '投稿テンプレート' : 'リプライ用テンプレート'}
          </label>
          <select
            id="arf-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">（選んでください）</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.no}. {t.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="arf-cap">
            {kind === 'auto_post' ? '1日の投稿数（時間枠モード）' : '1日の上限回数'}
          </label>
          <input
            id="arf-cap"
            type="number"
            min={1}
            value={kind === 'auto_post' ? postsPerDay : dailyCap}
            onChange={(e) =>
              kind === 'auto_post'
                ? setPostsPerDay(Number(e.target.value))
                : setDailyCap(Number(e.target.value))
            }
          />
        </div>
      </div>

      <div className="field">
        <label>実行するアカウント</label>
        {(accounts ?? []).length === 0 && <p className="faded">アカウントがまだありません。</p>}
        {(accounts ?? []).map((a) => (
          <label key={a.id} style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={accountIds.includes(a.id)}
              onChange={() => setAccountIds(toggle(accountIds, a.id))}
            />{' '}
            @{a.handle}
          </label>
        ))}
      </div>

      {kind === 'auto_post' && (
        <>
          <div className="form-row">
            <div className="field">
              <label htmlFor="arf-mode">投稿スケジュール</label>
              <select
                id="arf-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as AutoPostMode)}
              >
                <option value="window">時間枠（枠内に分散）</option>
                <option value="times">指定時刻</option>
                <option value="weekly">曜日指定</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="arf-order">アカウントの順番</label>
              <select
                id="arf-order"
                value={order}
                onChange={(e) => setOrder(e.target.value as 'shuffle' | 'sequential')}
              >
                <option value="shuffle">シャッフル</option>
                <option value="sequential">登録順</option>
              </select>
            </div>
          </div>

          {mode === 'window' && (
            <div className="form-row">
              <div className="field">
                <label htmlFor="arf-start">開始時刻</label>
                <input
                  id="arf-start"
                  type="time"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="arf-end">終了時刻</label>
                <input
                  id="arf-end"
                  type="time"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                />
              </div>
            </div>
          )}

          {(mode === 'times' || mode === 'weekly') && (
            <div className="form-row">
              <div className="field">
                <label htmlFor="arf-times">時刻（カンマ区切り、最大48件）</label>
                <input
                  id="arf-times"
                  value={timesText}
                  onChange={(e) => setTimesText(e.target.value)}
                  placeholder="09:00, 12:30, 19:00"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="arf-jitter">ジッター（分）</label>
                <select
                  id="arf-jitter"
                  value={jitterMin}
                  onChange={(e) => setJitterMin(Number(e.target.value))}
                >
                  {JITTER_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      ±{v}分
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {mode === 'weekly' && (
            <div className="field">
              <label>曜日</label>
              <div>
                {WEEKDAYS.map((label, i) => (
                  <label key={i} style={{ marginRight: 12 }}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(i)}
                      onChange={() => setWeekdays(toggle(weekdays.map(String), String(i)).map(Number))}
                    />{' '}
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {kind === 'auto_action' && (
        <>
          <div className="field">
            <label>自動操作の種類</label>
            <div>
              {ACTION_KINDS.map((k) => (
                <label key={k} style={{ marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={actionKinds.includes(k)}
                    onChange={() => setActionKinds(toggle(actionKinds, k))}
                  />{' '}
                  {BULK_ACTION_LABELS[k]}
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="arf-keyword">対象キーワード（空欄なら全投稿）</label>
            <input
              id="arf-keyword"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例：鹿島"
              autoComplete="off"
            />
          </div>
        </>
      )}

      <div className="field">
        <label style={{ display: 'block' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{' '}
          このルールを有効にする
        </label>
        <label style={{ display: 'block' }}>
          <input
            type="checkbox"
            checked={skipSearchBanned}
            onChange={(e) => setSkipSearchBanned(e.target.checked)}
          />{' '}
          シャドウバン判定のアカウントをスキップする
        </label>
      </div>

      {error && <p style={{ color: 'var(--danger, #c00)' }}>{error}</p>}
      <div className="toolbar">
        <Button type="submit" disabled={saving}>
          {saving ? '保存中…' : rule ? '保存する' : '作成する'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          キャンセル
        </Button>
      </div>
    </form>
  );
}
