import { describe, expect, it } from 'vitest';
import { searchBanVerdict } from './banCheckService';

describe('searchBanVerdict (§9-1: 話題×最新)', () => {
  it('both visible -> visible', () => {
    expect(searchBanVerdict(true, true)).toBe('visible');
  });

  it('topic hidden only -> topic_hidden', () => {
    expect(searchBanVerdict(false, true)).toBe('topic_hidden');
  });

  it('both hidden -> both_hidden', () => {
    expect(searchBanVerdict(false, false)).toBe('both_hidden');
  });

  it('fetch failure on either side -> unknown', () => {
    expect(searchBanVerdict(null, true)).toBe('unknown');
    expect(searchBanVerdict(true, null)).toBe('unknown');
    expect(searchBanVerdict(null, null)).toBe('unknown');
  });
});
