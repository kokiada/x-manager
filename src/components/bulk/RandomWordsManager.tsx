import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import {
  deleteRandomWordSet,
  getRandomWordSets,
  setRandomWords,
} from '../../db/repository';
import { downloadTextFile } from '../../lib/csv';
import { parseRandomWords, RANDOM_MAX, RANDOM_MIN } from '../../lib/randomText';
import { parseRandomWordsCsv, randomWordsToCsv } from '../../lib/templateCsv';
import { Button, useToast } from '../ui';

/**
 * Random word list (ランダム文言) manager. Each list is numbered
 * 1–2000 and referenced from post text as [RandomN]; at post time one
 * word is picked at random per placeholder (research §6-3).
 */
export function RandomWordsManager() {
  const toast = useToast();
  const sets = useLiveQuery(() => db.randomWordSets.orderBy('no').toArray(), [], undefined);
  const [newNo, setNewNo] = useState('');
  const [editingNo, setEditingNo] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [csvMode, setCsvMode] = useState<'append' | 'replace'>('append');
  const [csvNotes, setCsvNotes] = useState<string[]>([]);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const startEdit = (no: number, words: string[]) => {
    setEditingNo(no);
    setDraft(words.join('\n'));
  };

  const saveEdit = async () => {
    if (editingNo === null) return;
    await setRandomWords(editingNo, parseRandomWords(draft));
    toast.push(`[Random${editingNo}] の文言を保存しました`, 'ok');
    setEditingNo(null);
  };

  const addSet = async () => {
    const no = Number(newNo);
    if (!Number.isInteger(no) || no < RANDOM_MIN || no > RANDOM_MAX) {
      toast.push(`番号は${RANDOM_MIN}〜${RANDOM_MAX}で指定してください`, 'err');
      return;
    }
    if ((sets ?? []).some((s) => s.no === no)) {
      toast.push(`[Random${no}] は既にあります。一覧から編集してください`, 'err');
      return;
    }
    await setRandomWords(no, []);
    setNewNo('');
    startEdit(no, []);
  };

  const remove = async (no: number) => {
    if (!window.confirm(`[Random${no}] の文言リストを削除しますか？`)) return;
    await deleteRandomWordSet(no);
    toast.push(`[Random${no}] を削除しました`, 'ok');
  };

  const exportCsv = async () => {
    const map = new Map(Object.entries(await getRandomWordSets()).map(([k, v]) => [Number(k), v]));
    downloadTextFile('random-words.csv', randomWordsToCsv(map));
    toast.push('ランダム文言CSVを書き出しました', 'ok');
  };

  const importCsv = async (file: File | null) => {
    if (!file) return;
    const parsed = parseRandomWordsCsv(await file.text());
    const notes = [...parsed.warnings];
    const existing = await getRandomWordSets();
    for (const no of parsed.cleared) {
      await setRandomWords(no, []);
    }
    for (const [no, words] of parsed.byNo) {
      if (csvMode === 'replace') {
        await setRandomWords(no, words);
      } else {
        const merged = parseRandomWords([...(existing[no] ?? []), ...words].join('\n'));
        await setRandomWords(no, merged);
      }
    }
    setCsvNotes(notes);
    toast.push('ランダム文言CSVを取り込みました', 'ok');
    if (csvInputRef.current) csvInputRef.current.value = '';
  };

  return (
    <div>
      <p className="faded" style={{ fontSize: 13 }}>
        本文に <span className="mono">[Random1]</span> のように書くと、投稿ごとにその番号の文言から
        1つがランダムに選ばれて置き換わります。文言は1行に1つ、URLも使えます（
        <span className="mono">&lt;br&gt;</span> は改行になります）。
      </p>
      <div className="toolbar">
        <input
          type="number"
          min={RANDOM_MIN}
          max={RANDOM_MAX}
          placeholder="番号（1〜2000）"
          value={newNo}
          onChange={(e) => setNewNo(e.target.value)}
          style={{ width: 150 }}
          aria-label="新しいランダム文言の番号"
        />
        <Button onClick={() => void addSet()} disabled={!newNo}>
          ＋ 文言リストを追加
        </Button>
        <span className="spacer" />
        <Button onClick={() => void exportCsv()} disabled={!sets || sets.length === 0}>
          CSV書出
        </Button>
        <select value={csvMode} onChange={(e) => setCsvMode(e.target.value as 'append' | 'replace')} aria-label="CSV取込モード">
          <option value="append">取込: 番号の文言に追加</option>
          <option value="replace">取込: 番号の文言を置き換え</option>
        </select>
        <Button onClick={() => csvInputRef.current?.click()}>CSV取込</Button>
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => void importCsv(e.target.files?.[0] ?? null)}
        />
      </div>
      <p className="dim" style={{ fontSize: 12 }}>
        CSV形式: <span className="mono">no,word</span>（1行=1文言）。文言が空欄の行は、その番号のリストを空にします。
      </p>
      {csvNotes.length > 0 && (
        <ul className="note-list">
          {csvNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div className="ledger-simple">
        {sets === undefined && <div className="ledger-empty">読み込み中…</div>}
        {sets !== undefined && sets.length === 0 && (
          <div className="ledger-empty">文言リストはまだありません。番号を指定して追加してください。</div>
        )}
        {(sets ?? []).map((s) => (
          <div key={s.no} className="simple-row" style={{ alignItems: 'flex-start' }}>
            <span className="mono" style={{ color: 'var(--c-amber)', fontWeight: 600 }}>
              [Random{s.no}]
            </span>
            {editingNo === s.no ? (
              <span className="pick-main">
                <textarea
                  rows={5}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="1行に1つの文言"
                  style={{ width: '100%' }}
                  aria-label={`[Random${s.no}] の文言`}
                />
                <span className="toolbar" style={{ marginTop: 6 }}>
                  <Button small variant="primary" onClick={() => void saveEdit()}>
                    保存
                  </Button>
                  <Button small variant="ghost" onClick={() => setEditingNo(null)}>
                    キャンセル
                  </Button>
                </span>
              </span>
            ) : (
              <span className="pick-main">
                <span className="faded" style={{ fontSize: 12.5 }}>
                  {s.words.length}件の文言
                  {s.words.length > 0 && `: ${s.words.slice(0, 3).join(' / ')}${s.words.length > 3 ? ' …' : ''}`}
                </span>
              </span>
            )}
            {editingNo !== s.no && (
              <span className="row-actions">
                <Button small onClick={() => startEdit(s.no, s.words)}>
                  編集
                </Button>{' '}
                <Button small variant="danger" onClick={() => void remove(s.no)}>
                  削除
                </Button>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
