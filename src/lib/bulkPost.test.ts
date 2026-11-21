import { describe, expect, it } from 'vitest';
import type { MediaMeta } from '../db/types';
import { buildPostContent, emptyPayload, validateCompose, weightedLength } from './bulkPost';

const img = (name: string): MediaMeta => ({ name, kind: 'image', mime: 'image/png', size: 100 });

describe('weightedLength', () => {
  it('counts ASCII as 1 and CJK as 2', () => {
    expect(weightedLength('abc')).toBe(3);
    expect(weightedLength('あいう')).toBe(6);
    expect(weightedLength('aあ')).toBe(3);
  });

  it('counts every URL as 23 characters', () => {
    expect(weightedLength('see https://example.com/very/long/path end')).toBe(3 + 1 + 23 + 1 + 3);
    expect(weightedLength('https://x.com/a')).toBe(23);
  });
});

describe('buildPostContent', () => {
  it('maps a normal post with reply permission and partnership', () => {
    const payload = {
      ...emptyPayload(),
      segments: ['本文'],
      replyPermission: 'verified' as const,
      paidPartnership: true,
    };
    const { content } = buildPostContent(payload, ['本文']);
    expect(content.text).toBe('本文');
    expect(content.targetType).toBe('normal');
    expect(content.replyPermission).toBe('verified');
    expect(content.paidPartnership).toBe(true);
    expect(content.threadTexts).toBeUndefined();
  });

  it('chains tree segments as threadTexts and drops reply permission for replies', () => {
    const payload = {
      ...emptyPayload(),
      segments: ['1', '2'],
      targetType: 'reply' as const,
      replyToUrl: 'https://x.com/a/status/1',
      replyPermission: 'verified' as const,
    };
    const { content } = buildPostContent(payload, ['1', '2']);
    expect(content.threadTexts).toEqual(['2']);
    expect(content.replyToUrl).toBe('https://x.com/a/status/1');
    // Reply permission is normal-post only (§6-4).
    expect(content.replyPermission).toBeUndefined();
  });

  it('carries the community ID only for community posts', () => {
    const community = {
      ...emptyPayload(),
      segments: ['x'],
      targetType: 'community' as const,
      communityId: '1700000000000000000',
    };
    const { content } = buildPostContent(community, ['x']);
    expect(content.communityId).toBe('1700000000000000000');
    expect(content.targetType).toBe('community');

    const normal = { ...emptyPayload(), segments: ['x'], communityId: '1700000000000000000' };
    expect(buildPostContent(normal, ['x']).content.communityId).toBeUndefined();
  });

  it('attaches no media when a poll is present', () => {
    const payload = {
      ...emptyPayload(),
      segments: ['q'],
      media: [img('a.png')],
      poll: { choices: ['x', 'y'] },
    };
    const { content, attached } = buildPostContent(payload, ['q']);
    expect(attached).toEqual([]);
    expect(content.mediaCount).toBe(0);
  });

  it("attaches media in 'all' mode up to 20", () => {
    const media = Array.from({ length: 25 }, (_, i) => img(`m${i}.png`));
    const payload = { ...emptyPayload(), segments: ['x'], media };
    const { content, attached } = buildPostContent(payload, ['x']);
    expect(attached).toHaveLength(20);
    expect(content.mediaCount).toBe(20);
  });
});

describe('validateCompose', () => {
  const base = { accountCount: 1 };

  it('accepts a plain text post', () => {
    const v = validateCompose({ ...emptyPayload(), segments: ['hello'] }, base);
    expect(v.errors).toEqual([]);
  });

  it('requires accounts and a body (unless media or poll)', () => {
    expect(validateCompose(emptyPayload(), { accountCount: 0 }).errors.length).toBeGreaterThan(0);
    const withMedia = { ...emptyPayload(), media: [img('a.png')] };
    expect(validateCompose(withMedia, base).errors).toEqual([]);
  });

  it('requires a target for reply and community posts', () => {
    const reply = { ...emptyPayload(), segments: ['x'], targetType: 'reply' as const };
    expect(validateCompose(reply, base).errors.some((e) => e.includes('リプライ'))).toBe(true);
    const comm = { ...emptyPayload(), segments: ['x'], targetType: 'community' as const };
    expect(validateCompose(comm, base).errors.some((e) => e.includes('コミュニティ'))).toBe(true);
  });

  it('rejects media + poll together and polls with <2 choices', () => {
    const both = { ...emptyPayload(), segments: ['x'], media: [img('a.png')], poll: { choices: ['a', 'b'] } };
    expect(validateCompose(both, base).errors.some((e) => e.includes('アンケート'))).toBe(true);
    const thin = { ...emptyPayload(), segments: ['x'], poll: { choices: ['only'] } };
    expect(validateCompose(thin, base).errors.some((e) => e.includes('選択肢'))).toBe(true);
  });

  it('flags segments over the 280 weighted limit', () => {
    const long = { ...emptyPayload(), segments: ['あ'.repeat(141)] }; // 282 weighted
    expect(validateCompose(long, base).errors.some((e) => e.includes('280'))).toBe(true);
  });

  it('applies reservation rules: no poll/community, >= 5 minutes ahead', () => {
    const now = 1_000_000_000_000;
    const soon = validateCompose(
      { ...emptyPayload(), segments: ['x'] },
      { accountCount: 1, forReservation: true, scheduledAt: now + 4 * 60_000, now },
    );
    expect(soon.errors.some((e) => e.includes('5分'))).toBe(true);
    const ok = validateCompose(
      { ...emptyPayload(), segments: ['x'] },
      { accountCount: 1, forReservation: true, scheduledAt: now + 5 * 60_000, now },
    );
    expect(ok.errors).toEqual([]);
    const poll = validateCompose(
      { ...emptyPayload(), segments: ['x'], poll: { choices: ['a', 'b'] } },
      { accountCount: 1, forReservation: true, scheduledAt: now + 60 * 60_000, now },
    );
    expect(poll.errors.some((e) => e.includes('予約投稿ではアンケート'))).toBe(true);
  });
});
