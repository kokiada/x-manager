import { describe, expect, it } from 'vitest';
import type { Template } from '../db/types';
import { parseCsv, toCsv } from './csv';
import {
  parseRandomWordsCsv,
  parseTemplatesCsv,
  randomWordsToCsv,
  templatesToCsvWithGroups,
} from './templateCsv';

const template = (patch: Partial<Template>): Template => ({
  id: 't1',
  no: 1,
  title: 'タイトル',
  body: '本文です',
  groupId: null,
  media: [],
  poll: null,
  thread: [],
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

describe('csv primitives', () => {
  it('round-trips quotes, commas and newlines', () => {
    const rows = [
      ['a', 'b,c', 'd"e'],
      ['line1\nline2', '', 'f'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it('parses CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('templates CSV', () => {
  it('round-trips templates through export → overwrite import', () => {
    const templates = [
      template({ no: 3, title: '告知, その1', body: '一行目\n二行目 "引用"', groupId: 'g1' }),
      template({
        no: 7,
        title: '',
        body: '',
        media: [{ name: 'a.png', kind: 'image', mime: '', size: 0 }],
      }),
    ];
    const csv = templatesToCsvWithGroups(templates, new Map([['g1', '定期告知']]));
    const parsed = parseTemplatesCsv(csv, 'overwrite');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      no: 3,
      title: '告知, その1',
      body: '一行目\n二行目 "引用"',
      groupName: '定期告知',
    });
    expect(parsed.rows[1].no).toBe(7);
    expect(parsed.rows[1].media.map((m) => m.name)).toEqual(['a.png']);
  });

  it("append mode ignores the no column and keeps file order", () => {
    const csv = 'no,text,title,images,group\n5,本文A,,,\n9,本文B,,,';
    const parsed = parseTemplatesCsv(csv, 'append');
    expect(parsed.rows.map((r) => r.body)).toEqual(['本文A', '本文B']);
    expect(parsed.rows[0].no).toBeUndefined();
  });

  it('overwrite mode: a later row with the same no wins', () => {
    const csv = 'no,text,title,images,group\n2,古い,,,\n2,新しい,,,';
    const parsed = parseTemplatesCsv(csv, 'overwrite');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].body).toBe('新しい');
  });

  it('overwrite mode skips rows with an out-of-range no', () => {
    const csv = 'no,text,title,images,group\n0,本文,,,\n2001,本文,,,\n4,本文,,,';
    const parsed = parseTemplatesCsv(csv, 'overwrite');
    expect(parsed.rows.map((r) => r.no)).toEqual([4]);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('skips rows with neither text nor media, and bad media extensions', () => {
    const csv = 'no,text,title,images,group\n1,,,, \n2,本文,,a.bmp,\n3,本文,,ok.png,';
    const parsed = parseTemplatesCsv(csv, 'append');
    expect(parsed.rows.map((r) => r.body)).toEqual(['本文', '本文']);
    expect(parsed.rows[0].media).toEqual([]);
    expect(parsed.rows[1].media.map((m) => m.name)).toEqual(['ok.png']);
  });

  it('accepts Japanese headers', () => {
    const csv = '番号,本文,タイトル,画像,グループ\n3,本文です,題,,組A';
    const parsed = parseTemplatesCsv(csv, 'overwrite');
    expect(parsed.rows[0]).toMatchObject({ no: 3, body: '本文です', title: '題', groupName: '組A' });
  });

  it('accepts split image1…image4 columns', () => {
    const csv = 'no,text,title,image1,image2,group\n1,本文,,a.png,b.mp4,';
    const parsed = parseTemplatesCsv(csv, 'append');
    expect(parsed.rows[0].media.map((m) => m.name)).toEqual(['a.png', 'b.mp4']);
  });
});

describe('random words CSV', () => {
  it('round-trips word sets through export → import', () => {
    const sets = new Map<number, readonly string[]>([
      [1, ['おはよう', 'こんにちは']],
      [12, ['行ってきます']],
    ]);
    const parsed = parseRandomWordsCsv(randomWordsToCsv(sets));
    expect(parsed.byNo.get(1)).toEqual(['おはよう', 'こんにちは']);
    expect(parsed.byNo.get(12)).toEqual(['行ってきます']);
    expect(parsed.cleared.size).toBe(0);
  });

  it('skips out-of-range numbers and folds duplicates', () => {
    const csv = 'no,word\n0,x\n2001,y\n3,同じ\n3,同じ\n3,別';
    const parsed = parseRandomWordsCsv(csv);
    expect(parsed.byNo.get(3)).toEqual(['同じ', '別']);
    expect(parsed.byNo.has(0)).toBe(false);
    expect(parsed.warnings).toHaveLength(2);
  });

  it('an empty word row clears that number', () => {
    const csv = 'no,word\n5,消える\n5,\n7,残る';
    const parsed = parseRandomWordsCsv(csv);
    expect(parsed.cleared.has(5)).toBe(true);
    expect(parsed.byNo.has(5)).toBe(false);
    expect(parsed.byNo.get(7)).toEqual(['残る']);
  });
});
