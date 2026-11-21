import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { ComposePayload, Template } from '../db/types';
import {
  INTERVAL_MAX_SEC,
  INTERVAL_MIN_SEC,
  MEDIA_PER_POST_MAX,
  REPLY_PERMISSIONS,
  REPLY_PERMISSION_LABELS,
  type ReplyPermission,
} from '../db/types';
import { createReservation } from '../db/repository';
import { getExecutorMode } from '../executor';
import { errorMessageOf } from '../lib/errorMessage';
import { checkExtensionReady } from '../lib/extensionPrecheck';
import { createAndRunJob } from '../lib/bulkPostService';
import { buildPostContent, validateCompose, weightedLength, POST_CHAR_LIMIT } from '../lib/bulkPost';
import { expandRandomText, findRandomPlaceholders, type RandomWordSets } from '../lib/randomText';
import { AccountOrderPicker } from '../components/bulk/AccountOrderPicker';
import { AutoPostManager } from '../components/bulk/AutoPostManager';
import { JobCard, JobHistory } from '../components/bulk/JobHistory';
import { MediaPicker, type SelectedMedia } from '../components/bulk/MediaPicker';
import { PollEditor } from '../components/bulk/PollEditor';
import { RandomWordsManager } from '../components/bulk/RandomWordsManager';
import { TemplateManager } from '../components/bulk/TemplateManager';
import { Button, useToast } from '../components/ui';

type View = 'compose' | 'templates' | 'history' | 'autopost';

function toLocalInputValue(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BulkPost() {
  const toast = useToast();
  const [view, setView] = useState<View>('compose');

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], []);
  const templateGroups = useLiveQuery(() => db.templateGroups.toArray(), [], []);
  const wordSetRows = useLiveQuery(() => db.randomWordSets.toArray(), [], []);
  const runningJob = useLiveQuery(
    async () => (await db.postJobs.where('status').equals('running').toArray())[0],
    [],
    undefined,
  );
  const settingsRow = useLiveQuery(() => db.settings.get('app'), [], undefined);

  /* ---------------------------- compose state ---------------------------- */
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [targetType, setTargetType] = useState<ComposePayload['targetType']>('normal');
  const [replyToUrl, setReplyToUrl] = useState('');
  const [communityId, setCommunityId] = useState('');
  const [segments, setSegments] = useState<string[]>(['']);
  const [mediaSel, setMediaSel] = useState<SelectedMedia[]>([]);
  const [mediaMode, setMediaMode] = useState<'all' | 'random'>('all');
  const [mediaRandomCount, setMediaRandomCount] = useState(4);
  const [poll, setPoll] = useState<ComposePayload['poll']>(null);
  const [replyPermission, setReplyPermission] = useState<ReplyPermission>('everyone');
  const [paidPartnership, setPaidPartnership] = useState(false);
  const [intervalSec, setIntervalSec] = useState(5);
  // Until the operator edits it here, the interval follows the
  // default from 設定 (M5). Once touched, the local value wins.
  const intervalTouched = useRef(false);
  useEffect(() => {
    const fromSettings = settingsRow?.settings.defaultIntervalSec;
    if (!intervalTouched.current && fromSettings) setIntervalSec(fromSettings);
  }, [settingsRow]);
  const [reserveAt, setReserveAt] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60_000)));
  const [templatePick, setTemplatePick] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [previewNonce, setPreviewNonce] = useState(0);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const wordSets: RandomWordSets = useMemo(() => {
    const sets: Record<number, readonly string[]> = {};
    for (const s of wordSetRows ?? []) sets[s.no] = s.words;
    return sets;
  }, [wordSetRows]);

  const payload: ComposePayload = useMemo(
    () => ({
      segments,
      targetType,
      replyToUrl: replyToUrl.trim() || undefined,
      communityId: communityId.trim() || undefined,
      media: mediaSel.map((m) => m.meta),
      mediaMode,
      mediaRandomCount,
      poll,
      replyPermission,
      paidPartnership,
    }),
    [segments, targetType, replyToUrl, communityId, mediaSel, mediaMode, mediaRandomCount, poll, replyPermission, paidPartnership],
  );

  const usedPlaceholders = useMemo(
    () => [...new Set(segments.flatMap((s) => findRandomPlaceholders(s)))],
    [segments],
  );
  const unregistered = usedPlaceholders.filter((n) => !(wordSets[n]?.length > 0));

  const preview = useMemo(() => {
    if (previewNonce === 0) return null;
    const expanded = segments.map((s) => expandRandomText(s, wordSets));
    return buildPostContent(payload, expanded).content;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewNonce]);

  /* ------------------------------ actions -------------------------------- */

  const applyTemplate = (t: Template) => {
    setSegments([t.body, ...t.thread]);
    // §6-3: a media template replaces the current media selection;
    // a poll template drops media (poll and media are exclusive).
    if (t.poll) {
      setPoll({ choices: [...t.poll.choices] });
      setMediaSel([]);
    } else if (t.media.length > 0) {
      setMediaSel(t.media.map((meta) => ({ meta })));
      setPoll(null);
    }
    toast.push(`テンプレート No.${t.no}「${t.title || '（無題）'}」を適用しました`, 'ok');
  };

  const insertPlaceholder = (n: number) => {
    const token = `[Random${n}]`;
    const el = bodyRef.current;
    setSegments((prev) => {
      const copy = [...prev];
      if (el && document.activeElement === el) {
        const { selectionStart: s, selectionEnd: e, value } = el;
        copy[0] = value.slice(0, s ?? value.length) + token + value.slice(e ?? value.length);
      } else {
        copy[0] = copy[0] + token;
      }
      return copy;
    });
  };

  const runNow = async () => {
    const v = validateCompose(payload, { accountCount: accountIds.length });
    setErrors(v.errors);
    setWarnings(v.warnings);
    if (v.errors.length > 0) return;
    // 拡張モードでは投稿を送る前に疎通確認（接続＋Cookie API）。
    // ダメならここで止めて理由を出し、1件30秒の時間切れを
    // 繰り返す前に防ぐ（アカウントチェックと同じ流れ）。
    if (getExecutorMode() === 'extension') {
      const ready = await checkExtensionReady();
      if (!ready.ok) {
        toast.push(ready.message, 'err');
        return;
      }
    }
    toast.push('一括投稿を開始しました', 'info');
    try {
      const job = await createAndRunJob({
        accountIds,
        payload,
        intervalSec,
        kind: 'immediate',
      });
      const doneCount = job.entries.filter((e) => e.status === 'done').length;
      const firstFailure = job.entries.find((e) => e.status === 'failed');
      const summary =
        job.status === 'cancelled'
          ? '一括投稿をキャンセルしました'
          : `一括投稿が完了しました（${doneCount}/${job.entries.length}件成功）`;
      // 失敗があれば最初の理由をそのまま付ける（件数だけでは
      // 原因が分からず、履歴タブを見に行く手間が増えるため）。
      const detail = firstFailure?.error ? `：${firstFailure.error}` : '';
      toast.push(summary + detail, job.status === 'done' ? 'ok' : 'info');
    } catch (err) {
      // createAndRunJob は失敗をジョブに記録して返す設計だが、
      // 万が一例外が漏れた場合も無言にしない。
      toast.push(`一括投稿に失敗しました：${errorMessageOf(err, '原因不明のエラー')}`, 'err');
    }
  };

  const reserve = async () => {
    const scheduledAt = new Date(reserveAt).getTime();
    const v = validateCompose(payload, {
      accountCount: accountIds.length,
      forReservation: true,
      scheduledAt,
    });
    setErrors(v.errors);
    setWarnings(v.warnings);
    if (v.errors.length > 0) return;
    await createReservation({ scheduledAt, accountIds, payload, intervalSec });
    toast.push('予約を作成しました。「予約・履歴」タブで確認できます', 'ok');
  };

  const setSegment = (i: number, text: string) =>
    setSegments((prev) => prev.map((s, j) => (j === i ? text : s)));

  /* -------------------------------- render ------------------------------- */

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">04</span>一括投稿
          </h1>
          <p className="page-lede">
            登録アカウントへ同じ内容を上から順に投稿します。間隔は1〜60秒、テンプレートとランダム文言で
            文面に揺らぎを持たせられます。実行方法は設定画面の「実行方法（X連携）」に従います。
          </p>
        </div>
      </div>

      <div className="view-tabs" role="tablist" aria-label="一括投稿の表示切替">
        <button type="button" role="tab" aria-selected={view === 'compose'} className={view === 'compose' ? 'active' : ''} onClick={() => setView('compose')}>
          投稿を作成
        </button>
        <button type="button" role="tab" aria-selected={view === 'templates'} className={view === 'templates' ? 'active' : ''} onClick={() => setView('templates')}>
          テンプレート / ランダム文言
        </button>
        <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
          予約・履歴
        </button>
        <button type="button" role="tab" aria-selected={view === 'autopost'} className={view === 'autopost' ? 'active' : ''} onClick={() => setView('autopost')}>
          自動投稿
        </button>
      </div>

      {view === 'autopost' && <AutoPostManager />}

      {view === 'templates' && (
        <div>
          <h2 className="section-title" style={{ marginTop: 0 }}>テンプレート（最大2,000件）</h2>
          <TemplateManager />
          <h2 className="section-title">ランダム文言</h2>
          <RandomWordsManager />
        </div>
      )}

      {view === 'history' && <JobHistory />}

      {view === 'compose' && (
        <div>
          {runningJob && (
            <div style={{ marginBottom: 16 }}>
              <JobCard job={runningJob} />
            </div>
          )}

          <div className="compose-grid">
            <section className="panel">
              <h2 className="panel-title">対象アカウント</h2>
              {accounts === undefined ? (
                <p className="faded">読み込み中…</p>
              ) : accounts.length === 0 ? (
                <p className="faded">アカウントがまだ登録されていません。アカウント画面から追加してください。</p>
              ) : (
                <AccountOrderPicker
                  accounts={accounts}
                  value={accountIds}
                  onChange={setAccountIds}
                  disabled={!!runningJob}
                />
              )}
            </section>

            <section className="panel">
              <h2 className="panel-title">投稿内容</h2>

              <div className="field">
                <label htmlFor="tpl-pick">テンプレートを適用</label>
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  <select
                    id="tpl-pick"
                    value={templatePick}
                    onChange={(e) => setTemplatePick(e.target.value)}
                    style={{ flex: '1 1 220px' }}
                  >
                    <option value="">テンプレートを選ぶ…</option>
                    {(templates ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        No.{t.no} {t.title || '（無題）'}
                        {t.groupId
                          ? `（${templateGroups?.find((g) => g.id === t.groupId)?.name ?? ''}）`
                          : ''}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={!templatePick}
                    onClick={() => {
                      const t = (templates ?? []).find((x) => x.id === templatePick);
                      if (t) applyTemplate(t);
                    }}
                  >
                    適用
                  </Button>
                </div>
              </div>

              <div className="field">
                <label>投稿先</label>
                <div className="toolbar" style={{ marginBottom: 6 }}>
                  {(
                    [
                      ['normal', '通常投稿'],
                      ['reply', 'リプライ投稿'],
                      ['community', 'コミュニティ投稿'],
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value} className="radio-label">
                      <input
                        type="radio"
                        name="target-type"
                        checked={targetType === value}
                        onChange={() => setTargetType(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {targetType === 'reply' && (
                  <input
                    type="text"
                    placeholder="リプライ先ポストのURL（https://x.com/.../status/...）"
                    value={replyToUrl}
                    onChange={(e) => setReplyToUrl(e.target.value)}
                    aria-label="リプライ先ポストのURL"
                  />
                )}
                {targetType === 'community' && (
                  <input
                    type="text"
                    placeholder="コミュニティID"
                    value={communityId}
                    onChange={(e) => setCommunityId(e.target.value)}
                    aria-label="コミュニティID"
                  />
                )}
              </div>

              <div className="field">
                <label htmlFor="post-body">本文</label>
                <textarea
                  id="post-body"
                  ref={bodyRef}
                  rows={5}
                  value={segments[0]}
                  onChange={(e) => setSegment(0, e.target.value)}
                  placeholder="投稿本文。[Random1] でランダム文言が使えます"
                />
                <div className="char-line">
                  <span className={weightedLength(segments[0]) > POST_CHAR_LIMIT ? 'over' : ''}>
                    {weightedLength(segments[0])} / {POST_CHAR_LIMIT}
                  </span>
                  {(wordSetRows ?? []).length > 0 && (
                    <span className="placeholder-btns">
                      {(wordSetRows ?? []).map((s) => (
                        <button key={s.no} type="button" className="mini-btn" onClick={() => insertPlaceholder(s.no)}>
                          [Random{s.no}] を挿入
                        </button>
                      ))}
                    </span>
                  )}
                </div>
                {unregistered.length > 0 && (
                  <p className="hint" style={{ color: 'var(--c-warn)' }}>
                    {unregistered.map((n) => `[Random${n}]`).join(' ')} の文言が未登録です（そのまま投稿されます）。
                    「テンプレート / ランダム文言」タブで登録できます。
                  </p>
                )}
              </div>

              <div className="field">
                <label>ツリーの続き（2件目以降は直前へのリプライ）</label>
                {segments.slice(1).map((seg, i) => (
                  <div key={i} className="poll-row" style={{ alignItems: 'flex-start' }}>
                    <span className="mono dim" style={{ fontSize: 12, paddingTop: 8 }}>
                      {i + 2}
                    </span>
                    <span style={{ flex: 1 }}>
                      <textarea
                        rows={2}
                        value={seg}
                        onChange={(e) => setSegment(i + 1, e.target.value)}
                        aria-label={`ツリーの続き ${i + 1}`}
                        style={{ width: '100%' }}
                      />
                      <span className={`char-line ${weightedLength(seg) > POST_CHAR_LIMIT ? 'over' : ''}`} style={{ display: 'block' }}>
                        {weightedLength(seg)} / {POST_CHAR_LIMIT}
                      </span>
                    </span>
                    <Button
                      small
                      variant="ghost"
                      onClick={() => setSegments((prev) => prev.filter((_, j) => j !== i + 1))}
                      aria-label="この続きを削除"
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <Button small onClick={() => setSegments((prev) => [...prev, ''])}>
                  ＋ 続きを追加（ツリー投稿）
                </Button>
              </div>

              <div className="field">
                <label>メディア</label>
                <MediaPicker
                  value={mediaSel}
                  onChange={(next) => {
                    setMediaSel(next);
                    if (next.length > 0) setPoll(null);
                  }}
                  mode={mediaMode}
                  onModeChange={setMediaMode}
                  randomCount={mediaRandomCount}
                  onRandomCountChange={setMediaRandomCount}
                  disabled={!!poll}
                  disabledReason="アンケートが付いているためメディアは使えません。アンケートを外すと選べます。"
                />
              </div>

              <div className="field">
                <label>アンケート</label>
                <PollEditor
                  value={poll}
                  onChange={(p) => {
                    setPoll(p);
                    if (p) setMediaSel([]);
                  }}
                  disabled={mediaSel.length > 0}
                />
                {mediaSel.length > 0 && (
                  <p className="hint">メディア（{mediaSel.length}件）が選択中のためアンケートは付けられません。</p>
                )}
              </div>

              <div className="form-row">
                <div className="field">
                  <label htmlFor="reply-perm">返信できるアカウント</label>
                  <select
                    id="reply-perm"
                    value={replyPermission}
                    disabled={targetType !== 'normal'}
                    onChange={(e) => setReplyPermission(e.target.value as ReplyPermission)}
                  >
                    {REPLY_PERMISSIONS.map((p) => (
                      <option key={p} value={p}>
                        {REPLY_PERMISSION_LABELS[p]}
                      </option>
                    ))}
                  </select>
                  <p className="hint">通常投稿のみ有効。ツリーでは1件目に付きます。</p>
                </div>
                <div className="field">
                  <label>有料パートナーシップ</label>
                  <label className="radio-label" style={{ paddingTop: 8 }}>
                    <input
                      type="checkbox"
                      checked={paidPartnership}
                      onChange={(e) => setPaidPartnership(e.target.checked)}
                    />
                    表示する（予約投稿でも可）
                  </label>
                </div>
              </div>

              <div className="toolbar">
                <Button small onClick={() => setPreviewNonce((n) => n + 1)}>
                  ランダム文言のプレビュー
                </Button>
                {preview && (
                  <span className="faded" style={{ fontSize: 12.5 }}>
                    ※投稿ごとに変わります
                  </span>
                )}
              </div>
              {preview && (
                <div className="preview-box">
                  <div style={{ whiteSpace: 'pre-wrap' }}>{preview.text}</div>
                  {(preview.threadTexts ?? []).map((t, i) => (
                    <div key={i} className="preview-thread">
                      ↳ {t}
                    </div>
                  ))}
                  <div className="dim mono" style={{ fontSize: 11.5, marginTop: 6 }}>
                    メディア {preview.mediaCount ?? 0}件 / 最大{MEDIA_PER_POST_MAX}件
                  </div>
                </div>
              )}
            </section>
          </div>

          <section className="panel" style={{ marginTop: 16 }}>
            <h2 className="panel-title">実行</h2>
            <div className="form-row">
              <div className="field">
                <label htmlFor="interval">投稿間隔（秒）</label>
                <input
                  id="interval"
                  type="number"
                  min={INTERVAL_MIN_SEC}
                  max={INTERVAL_MAX_SEC}
                  value={intervalSec}
                  onChange={(e) => {
                    intervalTouched.current = true;
                    setIntervalSec(Math.min(INTERVAL_MAX_SEC, Math.max(INTERVAL_MIN_SEC, Number(e.target.value) || INTERVAL_MIN_SEC)));
                  }}
                />
                <p className="hint">アカウントごとに上から順に、この間隔を空けて投稿します（{INTERVAL_MIN_SEC}〜{INTERVAL_MAX_SEC}秒）。</p>
              </div>
              <div className="field">
                <label htmlFor="reserve-at">予約日時（予約投稿の場合）</label>
                <input
                  id="reserve-at"
                  type="datetime-local"
                  value={reserveAt}
                  onChange={(e) => setReserveAt(e.target.value)}
                />
                <p className="hint">現在から5分以上先。アプリを開いている間に実行されます。アンケート・コミュニティ投稿は予約できません。</p>
              </div>
            </div>

            {errors.length > 0 && (
              <ul className="note-list error">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <ul className="note-list">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="toolbar" style={{ marginTop: 8 }}>
              <Button variant="primary" onClick={runNow} disabled={!!runningJob}>
                {runningJob ? '実行中…' : '今すぐ一括投稿'}
              </Button>
              <Button onClick={() => void reserve()} disabled={!!runningJob}>
                予約する
              </Button>
              <span className="faded" style={{ fontSize: 12.5 }}>
                対象 {accountIds.length}件 / ロック・凍結・未ログインは自動でスキップされます
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
