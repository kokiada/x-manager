/**
 * Auto-post slot computation (research §6-6).
 *
 * Three modes:
 * - random_window: N posts spread across a time window each day.
 * - fixed_times: a list of daily times, each with ±jitter (0/5/15/30 min).
 * - weekly: one weekday+time per entry, each with ±5 min jitter.
 *
 * A slot whose time passed more than 15 minutes ago is skipped
 * (本家: 「予定時刻を15分以上過ぎた投稿はスキップ」).
 * Pure functions with an injectable rng for deterministic tests.
 */

export type AutoPostMode = 'random_window' | 'fixed_times' | 'weekly';

export interface AutoPostRuleShape {
  mode: AutoPostMode;
  windowStart?: string;
  windowEnd?: string;
  postsPerDay?: number;
  order?: 'shuffle' | 'sequential';
  times?: string[];
  jitterMin?: 0 | 5 | 15 | 30;
  weekdaySchedule?: { weekday: number; time: string }[];
}

/** One scheduled posting slot on a given date. */
export interface AutoPostSlot {
  /** Stable key for "already fired today" tracking. */
  key: string;
  /** 'HH:MM' label (after jitter). */
  label: string;
  dueAt: number;
}

/** A slot whose scheduled time passed >15 minutes ago is skipped. */
export const AUTO_POST_LATE_MS = 15 * 60_000;

function parseHhMm(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function dateStr(d: Date): string {
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function atTime(day: Date, hhmm: string): number | null {
  const parsed = parseHhMm(hhmm);
  if (!parsed) return null;
  const d = new Date(day);
  d.setHours(parsed.h, parsed.m, 0, 0);
  return d.getTime();
}

/** Fisher–Yates shuffle with the injected rng. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Compute the slots for one calendar date. For random_window with an
 * overnight window (end <= start), the window runs until the next
 * day's end time, so slots may fall after midnight.
 */
export function computeSlotsForDate(
  rule: AutoPostRuleShape,
  day: Date,
  rng: () => number = Math.random,
): AutoPostSlot[] {
  const dayKey = dateStr(day);
  const slots: AutoPostSlot[] = [];

  if (rule.mode === 'fixed_times') {
    const times = (rule.times ?? []).filter(Boolean);
    const jitterMs = (rule.jitterMin ?? 15) * 60_000;
    times.forEach((t, i) => {
      const base = atTime(day, t);
      if (base === null) return;
      const dueAt = base + (jitterMs === 0 ? 0 : Math.round((rng() * 2 - 1) * jitterMs));
      const d = new Date(dueAt);
      slots.push({
        key: `${dayKey}|fixed|${i}`,
        label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        dueAt,
      });
    });
    return slots.sort((a, b) => a.dueAt - b.dueAt);
  }

  if (rule.mode === 'weekly') {
    const weekday = day.getDay();
    const entries = (rule.weekdaySchedule ?? []).filter((e) => e.weekday === weekday);
    entries.forEach((entry, i) => {
      const base = atTime(day, entry.time);
      if (base === null) return;
      // Weekly posts always carry ±5 min jitter (§6-6).
      const dueAt = base + Math.round((rng() * 2 - 1) * 5 * 60_000);
      const d = new Date(dueAt);
      slots.push({
        key: `${dayKey}|weekly|${i}`,
        label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        dueAt,
      });
    });
    return slots.sort((a, b) => a.dueAt - b.dueAt);
  }

  // random_window
  const startMs = atTime(day, rule.windowStart ?? '07:00');
  let endMs = atTime(day, rule.windowEnd ?? '23:00');
  if (startMs === null || endMs === null) return [];
  if (endMs <= startMs) endMs += 24 * 3600_000; // overnight window
  const count = Math.max(1, rule.postsPerDay ?? 3);
  const span = endMs - startMs;
  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    // Spread across the window: one slot per equal slice, jittered
    // inside its slice so posts never bunch up (§6-6).
    const sliceStart = startMs + (span * i) / count;
    const sliceEnd = startMs + (span * (i + 1)) / count;
    raw.push(sliceStart + rng() * (sliceEnd - sliceStart));
  }
  const ordered = rule.order === 'shuffle' ? shuffle(raw, rng) : raw.sort((a, b) => a - b);
  ordered.forEach((dueAt, i) => {
    const d = new Date(dueAt);
    slots.push({
      key: `${dayKey}|random|${i}`,
      label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      dueAt: Math.round(dueAt),
    });
  });
  return slots.sort((a, b) => a.dueAt - b.dueAt);
}

export interface DueSlots {
  /** Slots due now (within the 15-min late window) and not yet fired. */
  due: AutoPostSlot[];
  /** Slots skipped because they are more than 15 minutes late. */
  skippedLate: AutoPostSlot[];
}

/**
 * Split one day's slots into due / late-skipped, given the keys
 * already fired today. Call for both today and yesterday to catch
 * overnight random windows.
 */
export function dueSlots(
  rule: AutoPostRuleShape,
  day: Date,
  now: number,
  firedKeys: readonly string[],
  rng: () => number = Math.random,
): DueSlots {
  const fired = new Set(firedKeys);
  const due: AutoPostSlot[] = [];
  const skippedLate: AutoPostSlot[] = [];
  for (const slot of computeSlotsForDate(rule, day, rng)) {
    if (fired.has(slot.key) || slot.dueAt > now) continue;
    if (now - slot.dueAt > AUTO_POST_LATE_MS) skippedLate.push(slot);
    else due.push(slot);
  }
  return { due, skippedLate };
}

/** The next slot after `now` that has not fired (today or tomorrow). */
export function nextSlot(
  rule: AutoPostRuleShape,
  now: number,
  firedKeys: readonly string[],
  rng: () => number = Math.random,
): AutoPostSlot | null {
  const fired = new Set(firedKeys);
  const today = new Date(now);
  const tomorrow = new Date(now + 24 * 3600_000);
  const candidates = [
    ...computeSlotsForDate(rule, today, rng),
    ...computeSlotsForDate(rule, tomorrow, rng),
  ]
    .filter((s) => s.dueAt > now && !fired.has(s.key))
    .sort((a, b) => a.dueAt - b.dueAt);
  return candidates[0] ?? null;
}
