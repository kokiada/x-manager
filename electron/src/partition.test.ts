import { describe, expect, it } from 'vitest';
import { partitionName } from './partition.cjs';

describe('partitionName', () => {
  it('アカウントIDから persist partition 名を作る', () => {
    expect(partitionName('korosukeada')).toBe('persist:xmgr-korosukeada');
    expect(partitionName('smoke')).toBe('persist:xmgr-smoke');
  });

  it('IDに使える文字（英数字・-・_）はそのまま通す', () => {
    expect(partitionName('user-1_x')).toBe('persist:xmgr-user-1_x');
  });

  it('空・空白だけ・変な文字のIDは受け付けない', () => {
    expect(() => partitionName('')).toThrow(/アカウントID/);
    expect(() => partitionName('   ')).toThrow(/アカウントID/);
    expect(() => partitionName('a/b')).toThrow(/アカウントID/);
    expect(() => partitionName('a b')).toThrow(/アカウントID/);
    expect(() => partitionName('a:b')).toThrow(/アカウントID/);
    expect(() => partitionName('あいう')).toThrow(/アカウントID/);
  });

  it('文字列以外は受け付けない', () => {
    // @ts-expect-error 実行時の型チェック用
    expect(() => partitionName(null)).toThrow(/アカウントID/);
    // @ts-expect-error 実行時の型チェック用
    expect(() => partitionName(123)).toThrow(/アカウントID/);
  });

  it('長すぎるIDは受け付けない', () => {
    expect(() => partitionName('a'.repeat(65))).toThrow(/アカウントID/);
    expect(partitionName('a'.repeat(64))).toBe(`persist:xmgr-${'a'.repeat(64)}`);
  });
});
