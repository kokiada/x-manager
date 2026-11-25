import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { NewTemplate, Template } from '../../db/types';
import { TEMPLATE_TITLE_MAX } from '../../db/types';
import {
  createTemplate,
  createTemplateGroup,
  deleteTemplate,
  deleteTemplateGroup,
  listTemplateGroups,
  renameTemplateGroup,
  updateTemplate,
} from '../../db/repository';
import { downloadTextFile } from '../../lib/csv';
import { parseTemplatesCsv, templatesToCsvWithGroups, type TemplateCsvMode } from '../../lib/templateCsv';
import { Button, Modal, PlainBadge, useToast } from '../ui';
import { MediaPicker, type SelectedMedia } from './MediaPicker';
import { PollEditor } from './PollEditor';

interface FormState {
  title: string;
  body: string;
  groupId: string;
  thread: string[];
  poll: NewTemplate['poll'];
  media: SelectedMedia[];
  mediaMode: 'all' | 'random';
  mediaRandomCount: number;
}

const blankForm = (): FormState => ({
  title: '',
  body: '',
  groupId: '',
  thread: [],
  poll: null,
  media: [],
  mediaMode: 'all',
  mediaRandomCount: 4,
});

const formFromTemplate = (t: Template): FormState => ({
  title: t.title,
  body: t.body,
  groupId: t.groupId ?? '',
  thread: [...t.thread],
  poll: t.poll ? { choices: [...t.poll.choices] } : null,
  media: t.media.map((meta) => ({ meta })),
  mediaMode: 'all',
  mediaRandomCount: 4,
});

export function TemplateManager() {
  const toast = useToast();
  const templates = useLiveQuery(() => db.templates.orderBy('no').toArray(), [], undefined);
  const groups = useLiveQuery(() => db.templateGroups.orderBy('order').toArray(), [], []);
  const [groupFilter, setGroupFilter] = useState('all');
  const [editing, setEditing] = useState<{ template?: Template; form: FormState } | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [csvMode, setCsvMode] = useState<TemplateCsvMode>('append');
  const [csvNotes, setCsvNotes] = useState<string[]>([]);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const groupName = (id: string | null) =>
    id ? (groups?.find((g) => g.id === id)?.name ?? '—') : '未分類';

  const filtered = useMemo(() => {
    if (!templates) return [];
    return templates.filter((t) => groupFilter === 'all' || (t.groupId ?? '') === groupFilter);
  }, [templates, groupFilter]);

  const openNew = () => setEditing({ form: blankForm() });
  const openEdit = (t: Template) => setEditing({ template: t, form: formFromTemplate(t) });

  const saveForm = async () => {
    if (!editing) return;
    const { form } = editing;
    const input: NewTemplate = {
      title: form.title.trim().slice(0, TEMPLATE_TITLE_MAX),
      body: form.body,
      groupId: form.groupId || null,
      media: form.media.map((m) => m.meta),
      poll: form.poll
        ? { choices: form.poll.choices.map((c) => c.trim()).filter(Boolean) }
        : null,
      thread: form.thread.filter((s) => s.trim() !== ''),
    };
    if (input.poll && input.poll.choices.length < 2) input.poll = null;
    try {
      if (editing.template) {
        await updateTemplate(editing.template.id, input);
        toast.push(`テンプレート No.${editing.template.no} を更新しました`, 'ok');
      } else {
        const created = await createTemplate(input);
        toast.push(`テンプレート No.${created.no} を作成しました`, 'ok');
      }
      setEditing(null);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : '保存に失敗しました', 'err');
    }
  };

  const remove = async (t: Template) => {
    if (!window.confirm(`テンプレート No.${t.no}「${t.title || '（無題）'}」を削除しますか？番号は詰められず、空き番号になります。`)) return;
    await deleteTemplate(t.id);
    toast.push(`テンプレート No.${t.no} を削除しました`, 'ok');
  };

  const addGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await createTemplateGroup(name);
      setNewGroupName('');
      toast.push(`グループ「${name}」を作成しました`, 'ok');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'グループ作成に失敗しました', 'err');
    }
  };

  const removeGroup = async (id: string, name: string) => {
    if (!window.confirm(`グループ「${name}」を削除しますか？中のテンプレートは未分類に戻ります。`)) return;
    await deleteTemplateGroup(id);
    toast.push(`グループ「${name}」を削除しました`, 'ok');
  };

  const exportCsv = () => {
    if (!templates) return;
    const nameById = new Map((groups ?? []).map((g) => [g.id, g.name]));
    downloadTextFile('templates.csv', templatesToCsvWithGroups(templates, nameById));
    toast.push('テンプレートCSVを書き出しました', 'ok');
  };

  const importCsv = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    const parsed = parseTemplatesCsv(text, csvMode);
    const notes = [...parsed.warnings];
    const groupByName = new Map((await listTemplateGroups()).map((g) => [g.name, g.id]));
    let applied = 0;
    for (const row of parsed.rows) {
      try {
        let groupId: string | null = null;
        if (row.groupName) {
          groupId = groupByName.get(row.groupName) ?? null;
          if (!groupId) {
            const created = await createTemplateGroup(row.groupName);
            groupId = created.id;
            groupByName.set(row.groupName, groupId);
          }
        }
        if (csvMode === 'overwrite' && row.no !== undefined) {
          const existing = (templates ?? []).find((t) => t.no === row.no);
          if (existing) {
            // Poll and thread are outside the CSV spec and are kept (§6-3).
            await updateTemplate(existing.id, {
              title: row.title,
              body: row.body,
              media: row.media,
              groupId,
            });
          } else {
            await createTemplate(
              { title: row.title, body: row.body, media: row.media, groupId, poll: null, thread: [] },
              row.no,
            );
          }
        } else {
          await createTemplate({
            title: row.title,
            body: row.body,
            media: row.media,
            groupId,
            poll: null,
            thread: [],
          });
        }
        applied++;
      } catch (err) {
        notes.push(err instanceof Error ? err.message : '取り込みに失敗した行があります');
      }
    }
    setCsvNotes(notes);
    toast.push(`テンプレートCSVを取り込みました（${applied}件）`, applied > 0 ? 'ok' : 'err');
    if (csvInputRef.current) csvInputRef.current.value = '';
  };

  const form = editing?.form;
  const setForm = (patch: Partial<FormState>) =>
    setEditing((cur) => (cur ? { ...cur, form: { ...cur.form, ...patch } } : cur));

  return (
    <div>
      <div className="toolbar">
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="テンプレートグループで絞り込み">
          <option value="all">全グループ</option>
          <option value="">未分類</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <Button onClick={exportCsv} disabled={!templates || templates.length === 0}>
          CSV書出
        </Button>
        <select value={csvMode} onChange={(e) => setCsvMode(e.target.value as TemplateCsvMode)} aria-label="CSV取込モード">
          <option value="append">取込: 空き番号に追加</option>
          <option value="overwrite">取込: CSVの番号で上書き</option>
        </select>
        <Button onClick={() => csvInputRef.current?.click()}>CSV取込</Button>
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => void importCsv(e.target.files?.[0] ?? null)}
        />
        <Button variant="primary" onClick={openNew}>
          ＋ テンプレート作成
        </Button>
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        CSV形式: <span className="mono">no,text,title,images,group</span>（1行=1テンプレート、imagesはカンマ区切りのファイル名）。
        アンケートとツリーの続きはCSV対象外で、上書きしても保持されます。
      </p>
      {csvNotes.length > 0 && (
        <ul className="note-list">
          {csvNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div className="ledger-simple">
        {templates === undefined && <div className="ledger-empty">読み込み中…</div>}
        {templates !== undefined && filtered.length === 0 && (
          <div className="ledger-empty">テンプレートがありません。</div>
        )}
        {filtered.map((t) => (
          <div key={t.id} className="simple-row">
            <span className="mono" style={{ color: 'var(--c-amber)', fontWeight: 600 }}>
              No.{t.no}
            </span>
            <span className="pick-main">
              <strong>{t.title || '（無題）'}</strong>
              <span className="faded" style={{ display: 'block', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                {t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}
              </span>
            </span>
            <span className="row-badges">
              <PlainBadge>{groupName(t.groupId)}</PlainBadge>
              {t.media.length > 0 && <PlainBadge>メディア{t.media.length}</PlainBadge>}
              {t.poll && <PlainBadge>アンケート</PlainBadge>}
              {t.thread.length > 0 && <PlainBadge>ツリー+{t.thread.length}</PlainBadge>}
            </span>
            <span className="row-actions">
              <Button small onClick={() => openEdit(t)}>
                編集
              </Button>{' '}
              <Button small variant="danger" onClick={() => void remove(t)}>
                削除
              </Button>
            </span>
          </div>
        ))}
      </div>

      <h3 className="section-title">テンプレートグループ（最大100個）</h3>
      <div className="toolbar">
        <input
          type="text"
          placeholder="新しいグループ名"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          style={{ flex: '0 1 260px' }}
          aria-label="新しいテンプレートグループ名"
        />
        <Button onClick={() => void addGroup()} disabled={!newGroupName.trim()}>
          グループ追加
        </Button>
      </div>
      <div className="ledger-simple">
        {(groups ?? []).map((g) => (
          <div key={g.id} className="simple-row">
            <span className="pick-main">
              <strong>{g.name}</strong>{' '}
              <span className="faded" style={{ fontSize: 12 }}>
                {(templates ?? []).filter((t) => t.groupId === g.id).length}件
              </span>
            </span>
            <span className="row-actions">
              <Button
                small
                variant="ghost"
                onClick={() => {
                  const name = window.prompt('グループ名を変更', g.name);
                  if (name && name.trim()) void renameTemplateGroup(g.id, name.trim());
                }}
              >
                名前変更
              </Button>{' '}
              <Button small variant="danger" onClick={() => void removeGroup(g.id, g.name)}>
                削除
              </Button>
            </span>
          </div>
        ))}
        {(groups ?? []).length === 0 && <p className="faded">グループはまだありません。</p>}
      </div>

      {editing && form && (
        <Modal
          title={editing.template ? `テンプレート編集（No.${editing.template.no}）` : 'テンプレート作成'}
          onClose={() => setEditing(null)}
        >
          <div className="field">
            <label htmlFor="tpl-title">タイトル（管理用・投稿されません）</label>
            <input
              id="tpl-title"
              type="text"
              maxLength={TEMPLATE_TITLE_MAX}
              value={form.title}
              onChange={(e) => setForm({ title: e.target.value })}
              placeholder="例: 朝のあいさつ"
            />
          </div>
          <div className="field">
            <label htmlFor="tpl-group">グループ</label>
            <select id="tpl-group" value={form.groupId} onChange={(e) => setForm({ groupId: e.target.value })}>
              <option value="">未分類</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tpl-body">本文</label>
            <textarea
              id="tpl-body"
              rows={5}
              value={form.body}
              onChange={(e) => setForm({ body: e.target.value })}
              placeholder="本文。[Random1] のようなランダム文言も使えます"
            />
          </div>
          <div className="field">
            <label>ツリーの続き</label>
            {form.thread.map((seg, i) => (
              <div key={i} className="poll-row">
                <span className="mono dim" style={{ fontSize: 12 }}>
                  {i + 2}
                </span>
                <textarea
                  rows={2}
                  value={seg}
                  onChange={(e) => {
                    const thread = [...form.thread];
                    thread[i] = e.target.value;
                    setForm({ thread });
                  }}
                  aria-label={`ツリーの続き ${i + 1}`}
                />
                <Button
                  small
                  variant="ghost"
                  onClick={() => setForm({ thread: form.thread.filter((_, j) => j !== i) })}
                  aria-label="この続きを削除"
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button small onClick={() => setForm({ thread: [...form.thread, ''] })}>
              ＋ 続きを追加
            </Button>
          </div>
          <div className="field">
            <label>メディア（メタデータのみ保存）</label>
            <MediaPicker
              value={form.media}
              onChange={(media) => setForm({ media, poll: media.length > 0 ? null : form.poll })}
              mode={form.mediaMode}
              onModeChange={(mediaMode) => setForm({ mediaMode })}
              randomCount={form.mediaRandomCount}
              onRandomCountChange={(mediaRandomCount) => setForm({ mediaRandomCount })}
              disabled={!!form.poll}
              disabledReason="アンケート付きテンプレートではメディアは使えません。"
            />
          </div>
          <div className="field">
            <label>アンケート</label>
            <PollEditor
              value={form.poll}
              onChange={(poll) => setForm({ poll, media: poll ? [] : form.media })}
              disabled={form.media.length > 0}
            />
            {form.media.length > 0 && (
              <p className="hint">メディアがあるためアンケートは付けられません（Xの仕様）。</p>
            )}
          </div>
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={() => void saveForm()}>
              保存
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
