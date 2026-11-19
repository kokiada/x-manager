import type { MediaMeta, Template } from '../db/types';
import { MEDIA_SELECT_MAX, TEMPLATE_MAX, TEMPLATE_TITLE_MAX } from '../db/types';
import { parseCsv, toCsv } from './csv';
import { checkMedia } from './media';
import { parseRandomWords, RANDOM_MAX, RANDOM_MIN } from './randomText';

/**
 * CSV formats for templates and random word lists (research §6-3).
 *
 * Template CSV — one row per template:
 *   no,text,title,images,group
 *   - no: 1–2000 (used only in "overwrite" import mode)
 *   - text: body (required unless images are present)
 *   - title: management title, up to 50 chars, never posted
 *   - images: media file names, comma-separated inside the field
 *     (max 200). The split columns image1…image4 are also accepted.
 *   - group: template group name, up to 20 chars; an unknown name
 *     creates the group on import.
 *   Poll settings and tree continuations are NOT part of this CSV
 *   (per the XBoard spec) and survive an overwrite untouched.
 *   Headers may be English (above) or Japanese (番号/本文/タイトル/画像/グループ).
 *
 * Random-word CSV — one row per word:
 *   no,word
 *   - no: 1–2000 (rows outside are skipped)
 *   - word: one word; duplicates within a number fold into one.
 *     A row with an empty word clears that number's whole list.
 */

export const TEMPLATE_CSV_HEADER = ['no', 'text', 'title', 'images', 'group'] as const;
export const RANDOM_CSV_HEADER = ['no', 'word'] as const;

const TEMPLATE_HEADER_ALIASES: Record<string, string> = {
  no: 'no',
  '番号': 'no',
  text: 'text',
  '本文': 'text',
  title: 'title',
  'タイトル': 'title',
  images: 'images',
  '画像': 'images',
  '画像・動画': 'images',
  group: 'group',
  'グループ': 'group',
};

function mediaFromNames(names: string[], warnings: string[]): MediaMeta[] {
  const media: MediaMeta[] = [];
  for (const name of names) {
    const check = checkMedia({ name, size: 0 });
    if (!check.kind) {
      warnings.push(`対応形式でないため取り込みから外しました: ${name}`);
      continue;
    }
    media.push({ name, kind: check.kind, mime: '', size: 0 });
    if (media.length >= MEDIA_SELECT_MAX) {
      warnings.push(`メディアは${MEDIA_SELECT_MAX}件までに切り詰めました`);
      break;
    }
  }
  return media;
}

/* ------------------------------ templates ------------------------------ */

export function templatesToCsv(templates: readonly Template[]): string {
  const rows: string[][] = [[...TEMPLATE_CSV_HEADER]];
  for (const t of templates) {
    rows.push([
      String(t.no),
      t.body,
      t.title,
      t.media.map((m) => m.name).join(','),
      '', // group name is resolved by the caller (needs the group list)
    ]);
  }
  return toCsv(rows);
}

/** Export with group names filled in. */
export function templatesToCsvWithGroups(
  templates: readonly Template[],
  groupNameById: ReadonlyMap<string, string>,
): string {
  const rows: string[][] = [[...TEMPLATE_CSV_HEADER]];
  for (const t of templates) {
    rows.push([
      String(t.no),
      t.body,
      t.title,
      t.media.map((m) => m.name).join(','),
      t.groupId ? (groupNameById.get(t.groupId) ?? '') : '',
    ]);
  }
  return toCsv(rows);
}

export interface TemplateCsvRow {
  /** Present only in overwrite mode (validated 1–2000). */
  no?: number;
  title: string;
  body: string;
  media: MediaMeta[];
  groupName?: string;
}

export interface TemplateCsvImport {
  rows: TemplateCsvRow[];
  warnings: string[];
}

export type TemplateCsvMode = 'append' | 'overwrite';

export function parseTemplatesCsv(text: string, mode: TemplateCsvMode): TemplateCsvImport {
  const warnings: string[] = [];
  const raw = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (raw.length === 0) return { rows: [], warnings: ['CSVにデータ行がありません'] };

  // Header row: map columns by (possibly Japanese) header names.
  const header = raw[0].map((c) => TEMPLATE_HEADER_ALIASES[c.trim().toLowerCase()] ?? TEMPLATE_HEADER_ALIASES[c.trim()]);
  const hasHeader = header.includes('text') || header.includes('no');
  const col = (name: string) => (hasHeader ? header.indexOf(name) : -1);
  const idx = {
    no: hasHeader ? col('no') : 0,
    text: hasHeader ? col('text') : 1,
    title: hasHeader ? col('title') : 2,
    images: hasHeader ? col('images') : 3,
    group: hasHeader ? col('group') : 4,
  };
  // Split image columns image1…image4 (no header mapping; positional).
  const imageSplitIdx = hasHeader
    ? raw[0].map((c, i) => (/^image[1-4]$/i.test(c.trim()) ? i : -1)).filter((i) => i >= 0)
    : [];

  const dataRows = hasHeader ? raw.slice(1) : raw;
  const byNo = new Map<number, TemplateCsvRow>();
  const rows: TemplateCsvRow[] = [];

  dataRows.forEach((cells, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const get = (ix: number) => (ix >= 0 && ix < cells.length ? cells[ix] : '');
    const body = get(idx.text);
    let imageNames = get(idx.images)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const ix of imageSplitIdx) {
      const v = get(ix).trim();
      if (v) imageNames.push(v);
    }
    if (!body.trim() && imageNames.length === 0) {
      warnings.push(`${line}行目: 本文もメディアも無いためスキップしました`);
      return;
    }
    let title = get(idx.title).trim();
    if (title.length > TEMPLATE_TITLE_MAX) {
      warnings.push(`${line}行目: タイトルを${TEMPLATE_TITLE_MAX}文字に切り詰めました`);
      title = title.slice(0, TEMPLATE_TITLE_MAX);
    }
    let groupName = get(idx.group).trim() || undefined;
    if (groupName && groupName.length > 20) {
      warnings.push(`${line}行目: グループ名を20文字に切り詰めました`);
      groupName = groupName.slice(0, 20);
    }
    const media = mediaFromNames(imageNames, warnings);

    const row: TemplateCsvRow = { title, body, media, groupName };
    if (mode === 'overwrite') {
      const no = Number(get(idx.no));
      if (!Number.isInteger(no) || no < 1 || no > TEMPLATE_MAX) {
        warnings.push(`${line}行目: 番号が不正なためスキップしました`);
        return;
      }
      row.no = no;
      byNo.set(no, row); // a later row with the same no wins (§6-3)
    } else {
      rows.push(row);
    }
  });

  if (mode === 'overwrite') {
    return { rows: [...byNo.values()].sort((a, b) => (a.no ?? 0) - (b.no ?? 0)), warnings };
  }
  return { rows, warnings };
}

/* ----------------------------- random words ---------------------------- */

export function randomWordsToCsv(sets: ReadonlyMap<number, readonly string[]>): string {
  const rows: string[][] = [[...RANDOM_CSV_HEADER]];
  for (const no of [...sets.keys()].sort((a, b) => a - b)) {
    for (const word of sets.get(no) ?? []) rows.push([String(no), word]);
  }
  return toCsv(rows);
}

export interface RandomWordsCsvImport {
  /** Words collected per number (duplicates folded, in file order). */
  byNo: Map<number, string[]>;
  /** Numbers whose list an empty-word row clears. */
  cleared: Set<number>;
  warnings: string[];
}

export function parseRandomWordsCsv(text: string): RandomWordsCsvImport {
  const warnings: string[] = [];
  const raw = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const byNo = new Map<number, string[]>();
  const cleared = new Set<number>();
  if (raw.length === 0) return { byNo, cleared, warnings: ['CSVにデータ行がありません'] };

  const first = raw[0].map((c) => c.trim().toLowerCase());
  const hasHeader = first[0] === 'no' || first[0] === '番号';
  const dataRows = hasHeader ? raw.slice(1) : raw;

  dataRows.forEach((cells, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const no = Number((cells[0] ?? '').trim());
    if (!Number.isInteger(no) || no < RANDOM_MIN || no > RANDOM_MAX) {
      warnings.push(`${line}行目: 番号が範囲外のためスキップしました`);
      return;
    }
    const word = (cells[1] ?? '').trim();
    if (word === '') {
      cleared.add(no);
      byNo.delete(no);
      return;
    }
    const list = byNo.get(no) ?? [];
    list.push(word);
    byNo.set(no, list);
  });

  // Fold duplicates within each number (CSV spec, §6-3).
  for (const [no, words] of byNo) byNo.set(no, parseRandomWords(words.join('\n')));
  return { byNo, cleared, warnings };
}
