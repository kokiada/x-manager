import { describe, expect, it } from 'vitest';
import { APP_BUILD_TIME, APP_COMMIT, formatBuildTime, versionLabel } from './version';

describe('version', () => {
  it('コミットは短縮ハッシュ（無ければ dev）', () => {
    expect(APP_COMMIT).toMatch(/^([0-9a-f]{7,40}|dev)$/);
  });

  it('ビルド時刻を M/D HH:MM（ローカル時刻）に直す', () => {
    const d = new Date('2026-11-22T02:52:00.000Z');
    const pad = (v: number) => String(v).padStart(2, '0');
    expect(formatBuildTime('2026-11-22T02:52:00.000Z')).toBe(
      `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    );
    expect(formatBuildTime('')).toBe('');
    expect(formatBuildTime('not-a-date')).toBe('');
  });

  it('ラベルは「コミット · ビルド時刻」', () => {
    expect(versionLabel()).toContain(APP_COMMIT);
    if (APP_BUILD_TIME) {
      expect(versionLabel()).toMatch(/ · \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    }
  });
});
