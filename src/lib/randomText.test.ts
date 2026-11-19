import { describe, expect, it } from 'vitest';
import {
  expandRandomText,
  findRandomPlaceholders,
  parseRandomWords,
  type RandomWordSets,
} from './randomText';

const sets: RandomWordSets = {
  1: ['おはよう', 'こんにちは', 'こんばんは'],
  2: ['今日も一日がんばろう', '行ってきます'],
  7: ['一行目<br>二行目'],
};

/** Deterministic rng that returns the given values in order. */
const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('findRandomPlaceholders', () => {
  it('finds placeholders in order of appearance', () => {
    expect(findRandomPlaceholders('[Random2] x [Random1] y [Random2]')).toEqual([2, 1, 2]);
  });

  it('ignores out-of-range numbers', () => {
    expect(findRandomPlaceholders('[Random0] [Random2001] [Random2000]')).toEqual([2000]);
  });

  it('returns an empty list when there are none', () => {
    expect(findRandomPlaceholders('ただの文章です')).toEqual([]);
  });
});

describe('expandRandomText', () => {
  it('replaces a placeholder with a word from its set', () => {
    expect(expandRandomText('[Random1]！', sets, () => 0)).toBe('おはよう！');
    expect(expandRandomText('[Random1]！', sets, () => 0.999)).toBe('こんばんは！');
  });

  it('expands different placeholders independently', () => {
    const out = expandRandomText('[Random1]、[Random2]', sets, seq([0, 0.9]));
    expect(out).toBe('おはよう、行ってきます');
  });

  it('gives repeated placeholders independent picks', () => {
    const out = expandRandomText('[Random1]/[Random1]', sets, seq([0, 0.5]));
    expect(out).toBe('おはよう/こんにちは');
  });

  it('converts <br> in a chosen word to a newline', () => {
    expect(expandRandomText('[Random7]', sets, () => 0)).toBe('一行目\n二行目');
  });

  it('leaves placeholders with no registered words untouched', () => {
    expect(expandRandomText('[Random42] のまま', sets, () => 0)).toBe('[Random42] のまま');
    expect(expandRandomText('[Random0] [Random2001]', sets, () => 0)).toBe(
      '[Random0] [Random2001]',
    );
  });

  it('leaves text without placeholders unchanged', () => {
    expect(expandRandomText('通常のポスト本文', sets, () => 0.5)).toBe('通常のポスト本文');
  });
});

describe('parseRandomWords', () => {
  it('splits one word per line and trims whitespace', () => {
    expect(parseRandomWords('  alpha \nbeta\n\n gamma ')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('handles CRLF and folds duplicates', () => {
    expect(parseRandomWords('a\r\nb\r\na')).toEqual(['a', 'b']);
  });

  it('returns an empty list for blank input', () => {
    expect(parseRandomWords(' \n\n')).toEqual([]);
  });
});
