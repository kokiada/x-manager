import { describe, expect, it } from 'vitest';
import { planSessionImport, placeholderHandle } from './sessionImport';

describe('planSessionImport', () => {
  it('台帳に無いセッションだけ取り込み対象にする', () => {
    const plan = planSessionImport(
      [
        { accountId: 'a', handle: 'foo' },
        { accountId: 'b', handle: 'bar' },
      ],
      ['a'],
    );
    expect(plan).toEqual({
      toCreate: [{ accountId: 'b', handle: 'bar' }],
      alreadyLinked: 1,
    });
  });

  it('すべて未連携なら全件作る', () => {
    const plan = planSessionImport(
      [
        { accountId: 'a', handle: 'foo' },
        { accountId: 'b', handle: null },
      ],
      [],
    );
    expect(plan.toCreate).toEqual([
      { accountId: 'a', handle: 'foo' },
      { accountId: 'b', handle: 'linked-b' },
    ]);
    expect(plan.alreadyLinked).toBe(0);
  });

  it('ハンドルが無い・空のセッションは仮ハンドルで作る', () => {
    const plan = planSessionImport(
      [
        { accountId: 'abc12345', handle: null },
        { accountId: 'def67890', handle: '   ' },
        { accountId: 'ghi11111', handle: '@withAt' },
      ],
      [],
    );
    expect(plan.toCreate).toEqual([
      { accountId: 'abc12345', handle: 'linked-abc12345' },
      { accountId: 'def67890', handle: 'linked-def67890' },
      { accountId: 'ghi11111', handle: 'withAt' },
    ]);
  });

  it('同一IDの重複セッションは最初の1件だけにする', () => {
    const plan = planSessionImport(
      [
        { accountId: 'a', handle: 'first' },
        { accountId: 'a', handle: 'second' },
      ],
      [],
    );
    expect(plan.toCreate).toEqual([{ accountId: 'a', handle: 'first' }]);
    expect(plan.alreadyLinked).toBe(0);
  });

  it('IDが空のセッションは落とす', () => {
    const plan = planSessionImport(
      [
        { accountId: '', handle: 'x' },
        { accountId: 'a', handle: 'foo' },
      ],
      [],
    );
    expect(plan.toCreate).toEqual([{ accountId: 'a', handle: 'foo' }]);
  });

  it('セッションが無ければ何も作らない', () => {
    expect(planSessionImport([], ['a'])).toEqual({ toCreate: [], alreadyLinked: 0 });
  });
});

describe('placeholderHandle', () => {
  it('IDの先頭8文字を使う', () => {
    expect(placeholderHandle('abc123456789')).toBe('linked-abc12345');
    expect(placeholderHandle('short')).toBe('linked-short');
  });
});
