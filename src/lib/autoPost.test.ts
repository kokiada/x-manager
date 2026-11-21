import { describe, expect, it } from 'vitest';
import { seededRandom } from './analytics';
import {
  computeSlotsForDate,
  dueSlots,
  nextSlot,
  type AutoPostRuleShape,
} from './autoPost';

/**
 * All dates are built with the local-time constructor so the tests
 * pass in any timezone (the VM runs UTC; the user is Asia/Tokyo).
 * 2026-11-20 is a Friday.
 */
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const day = (y: number, mo: number, d: number) => new Date(y, mo - 1, d, 0, 0);

/** Fixed rng so slot times are deterministic in tests. */
const half = () => 0.5;

describe('computeSlotsForDate — fixed_times', () => {
  const rule: AutoPostRuleShape = {
    mode: 'fixed_times',
    times: ['09:00', '18:30'],
    jitterMin: 0,
  };

  it('produces one slot per configured time', () => {
    const slots = computeSlotsForDate(rule, day(2026, 11, 20), half);
    expect(slots).toHaveLength(2);
    expect(slots[0].label).toBe('09:00');
    expect(slots[1].label).toBe('18:30');
    expect(slots[0].dueAt).toBe(at(2026, 11, 20, 9, 0));
  });

  it('applies ±jitter inside the configured range', () => {
    const jittered: AutoPostRuleShape = { mode: 'fixed_times', times: ['12:00'], jitterMin: 15 };
    // rng 0.5 -> offset 0; rng 0 -> -15 min; rng 1 -> +15 min.
    const mid = computeSlotsForDate(jittered, day(2026, 11, 20), () => 0.5);
    expect(mid[0].dueAt).toBe(at(2026, 11, 20, 12, 0));
    const early = computeSlotsForDate(jittered, day(2026, 11, 20), () => 0);
    expect(early[0].dueAt).toBe(at(2026, 11, 20, 11, 45));
    const late = computeSlotsForDate(jittered, day(2026, 11, 20), () => 1);
    expect(late[0].dueAt).toBe(at(2026, 11, 20, 12, 15));
  });
});

describe('computeSlotsForDate — random_window', () => {
  const rule: AutoPostRuleShape = {
    mode: 'random_window',
    windowStart: '06:00',
    windowEnd: '20:00',
    postsPerDay: 4,
    order: 'sequential',
  };

  it('spreads posts across the window, one per slice', () => {
    const slots = computeSlotsForDate(rule, day(2026, 11, 20), half);
    expect(slots).toHaveLength(4);
    // rng 0.5 puts each slot at its slice midpoint: 07:45, 11:15, 14:45, 18:15.
    expect(slots.map((s) => s.label)).toEqual(['07:45', '11:15', '14:45', '18:15']);
  });

  it('an overnight window runs past midnight', () => {
    const overnight: AutoPostRuleShape = {
      mode: 'random_window',
      windowStart: '20:00',
      windowEnd: '02:00',
      postsPerDay: 2,
      order: 'sequential',
    };
    const slots = computeSlotsForDate(overnight, day(2026, 11, 20), half);
    expect(slots).toHaveLength(2);
    // 6h window in 2 slices of 3h: midpoints 21:30 and 00:30 (next day).
    expect(slots[0].label).toBe('21:30');
    expect(slots[1].label).toBe('00:30');
  });
});

describe('computeSlotsForDate — weekly', () => {
  it('fires only on the configured weekday with ±5 min jitter', () => {
    const rule: AutoPostRuleShape = {
      mode: 'weekly',
      weekdaySchedule: [
        { weekday: 5, time: '19:00' }, // Friday
        { weekday: 0, time: '10:00' }, // Sunday
      ],
    };
    // 2026-11-20 is a Friday.
    const friday = computeSlotsForDate(rule, day(2026, 11, 20), half);
    expect(friday).toHaveLength(1);
    expect(friday[0].label).toBe('19:00');
    // 2026-11-21 is a Saturday: nothing.
    const saturday = computeSlotsForDate(rule, day(2026, 11, 21), half);
    expect(saturday).toHaveLength(0);
  });
});

describe('dueSlots — the >15-min-late skip rule (§6-6)', () => {
  const rule: AutoPostRuleShape = { mode: 'fixed_times', times: ['09:00', '12:00'], jitterMin: 0 };

  it('a slot 10 minutes late is due; a slot 16 minutes late is skipped', () => {
    const { due, skippedLate } = dueSlots(rule, day(2026, 11, 20), at(2026, 11, 20, 12, 10), [], half);
    expect(due.map((s) => s.label)).toEqual(['12:00']);
    expect(skippedLate.map((s) => s.label)).toEqual(['09:00']);
  });

  it('already-fired slots are neither due nor skipped', () => {
    const slots = computeSlotsForDate(rule, day(2026, 11, 20), half);
    const { due, skippedLate } = dueSlots(
      rule,
      day(2026, 11, 20),
      at(2026, 11, 20, 12, 10),
      [slots[0].key, slots[1].key],
      half,
    );
    expect(due).toHaveLength(0);
    expect(skippedLate).toHaveLength(0);
  });

  it('future slots are not due', () => {
    const { due } = dueSlots(rule, day(2026, 11, 20), at(2026, 11, 20, 8, 0), [], half);
    expect(due).toHaveLength(0);
  });
});

describe('nextSlot', () => {
  it('returns the next unfired slot, rolling to tomorrow when needed', () => {
    const rule: AutoPostRuleShape = { mode: 'fixed_times', times: ['09:00'], jitterMin: 0 };
    const next = nextSlot(rule, at(2026, 11, 20, 10, 0), [], half);
    expect(next).not.toBeNull();
    expect(next!.dueAt).toBe(at(2026, 11, 21, 9, 0));
  });

  it('skips a slot already fired today', () => {
    const rule: AutoPostRuleShape = { mode: 'fixed_times', times: ['09:00', '18:00'], jitterMin: 0 };
    const slots = computeSlotsForDate(rule, day(2026, 11, 20), half);
    const next = nextSlot(rule, at(2026, 11, 20, 8, 0), [slots[0].key], half);
    expect(next!.label).toBe('18:00');
  });
});

describe('deterministic slots (seeded rng per rule + day)', () => {
  it('the same seed gives the same random-window slots on every call', () => {
    const rule: AutoPostRuleShape = {
      mode: 'random_window',
      windowStart: '06:00',
      windowEnd: '20:00',
      postsPerDay: 4,
    };
    const a = computeSlotsForDate(rule, day(2026, 11, 20), seededRandom('r1:2026-11-20'));
    const b = computeSlotsForDate(rule, day(2026, 11, 20), seededRandom('r1:2026-11-20'));
    expect(a).toEqual(b);
    // A different day seeds a different (but still valid) schedule.
    const c = computeSlotsForDate(rule, day(2026, 11, 21), seededRandom('r1:2026-11-21'));
    expect(c).toHaveLength(4);
    expect(c.map((s) => s.dueAt)).not.toEqual(a.map((s) => s.dueAt));
  });
});
