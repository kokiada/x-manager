import { describe, expect, it } from 'vitest';
import { authorHandleFromUrl, followTargetHandle } from './bulkActionService';

describe('authorHandleFromUrl', () => {
  it('extracts the handle from x.com status URLs', () => {
    expect(authorHandleFromUrl('https://x.com/kashima/status/123456')).toBe('kashima');
    expect(authorHandleFromUrl('https://x.com/kashima/status/123456?s=20')).toBe('kashima');
  });

  it('also accepts twitter.com links', () => {
    expect(authorHandleFromUrl('https://twitter.com/kashima/status/123456')).toBe('kashima');
  });

  it('returns null for non-status URLs', () => {
    expect(authorHandleFromUrl('https://x.com/kashima')).toBeNull();
    expect(authorHandleFromUrl('not a url')).toBeNull();
  });
});

describe('followTargetHandle', () => {
  it('strips a leading @ and trims whitespace', () => {
    expect(followTargetHandle('@kashima')).toBe('kashima');
    expect(followTargetHandle('  kashima  ')).toBe('kashima');
    expect(followTargetHandle('kashima')).toBe('kashima');
  });
});
