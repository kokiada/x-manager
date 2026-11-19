import { describe, expect, it } from 'vitest';
import { checkMedia, pickMediaForPost } from './media';

describe('checkMedia', () => {
  it('accepts supported image and video extensions', () => {
    expect(checkMedia({ name: 'a.png', size: 100 }).kind).toBe('image');
    expect(checkMedia({ name: 'b.JPG', size: 100 }).kind).toBe('image');
    expect(checkMedia({ name: 'c.webp', size: 100 }).kind).toBe('image');
    expect(checkMedia({ name: 'd.mp4', size: 100 }).kind).toBe('video');
    expect(checkMedia({ name: 'e.mov', size: 100 }).kind).toBe('video');
  });

  it('rejects unsupported extensions', () => {
    const r = checkMedia({ name: 'a.bmp', size: 100 });
    expect(r.ok).toBe(false);
    expect(r.kind).toBeNull();
  });

  it('warns (but allows) images over 5MB', () => {
    const r = checkMedia({ name: 'big.jpg', size: 6 * 1024 * 1024 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });

  it('rejects videos over 512MB or 140 seconds', () => {
    expect(checkMedia({ name: 'v.mp4', size: 513 * 1024 * 1024 }).ok).toBe(false);
    expect(checkMedia({ name: 'v.mp4', size: 100, durationSec: 141 }).ok).toBe(false);
    expect(checkMedia({ name: 'v.mp4', size: 100, durationSec: 140 }).ok).toBe(true);
    // Unknown duration cannot be judged — allowed.
    expect(checkMedia({ name: 'v.mp4', size: 100 }).ok).toBe(true);
  });
});

describe('pickMediaForPost', () => {
  const items = Array.from({ length: 30 }, (_, i) => `m${i}`);

  it("'all' takes items in order, capped at 20 per post", () => {
    const picked = pickMediaForPost(items, 'all', undefined);
    expect(picked).toHaveLength(20);
    expect(picked[0]).toBe('m0');
    expect(picked[19]).toBe('m19');
  });

  it("'random' picks N distinct items using the rng", () => {
    // rng always 0 → always takes the current head after removals.
    const picked = pickMediaForPost(items, 'random', 3, () => 0);
    expect(picked).toEqual(['m0', 'm1', 'm2']);
    // rng near 1 → takes from the tail.
    const tail = pickMediaForPost(items, 'random', 2, () => 0.999);
    expect(tail).toEqual(['m29', 'm28']);
  });

  it("'random' never exceeds 20 or the pool size", () => {
    expect(pickMediaForPost(items, 'random', 25, () => 0.5)).toHaveLength(20);
    expect(pickMediaForPost(['a', 'b'], 'random', 5, () => 0)).toEqual(['a', 'b']);
    expect(pickMediaForPost(items, 'random', 0, () => 0)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const src = ['a', 'b', 'c'];
    pickMediaForPost(src, 'random', 2, () => 0);
    expect(src).toEqual(['a', 'b', 'c']);
  });
});
