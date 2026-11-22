import { describe, expect, it } from 'vitest';
import { isPlaceholderHandle, planSessionImport } from './sessionImport';

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
      needsHandle: [],
      alreadyLinked: 1,
    });
  });

  it('ハンドルが無いセッションは仮ハンドルで作らず needsHandle に回す', () => {
    const plan = planSessionImport(
      [
        { accountId: 'a', handle: 'foo' },
        { accountId: 'b', handle: null },
        { accountId: 'c', handle: '   ' },
      ],
      [],
    );
    expect(plan.toCreate).toEqual([{ accountId: 'a', handle: 'foo' }]);
    expect(plan.needsHandle).toEqual(['b', 'c']);
    expect(plan.alreadyLinked).toBe(0);
  });

  it('ハンドルの先頭の @ は取る', () => {
    const plan = planSessionImport([{ accountId: 'ghi11111', handle: '@withAt' }], []);
    expect(plan.toCreate).toEqual([{ accountId: 'ghi11111', handle: 'withAt' }]);
    expect(plan.needsHandle).toEqual([]);
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
    expect(plan.needsHandle).toEqual([]);
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
    expect(planSessionImport([], ['a'])).toEqual({
      toCreate: [],
      needsHandle: [],
      alreadyLinked: 0,
    });
  });
});

describe('isPlaceholderHandle', () => {
  it('linked- で始まる仮ハンドルを見分ける', () => {
    expect(isPlaceholderHandle('linked-abc12345')).toBe(true);
    expect(isPlaceholderHandle('linked-')).toBe(true);
    expect(isPlaceholderHandle('korosukeada')).toBe(false);
    expect(isPlaceholderHandle('linkeduser')).toBe(false);
  });
});
