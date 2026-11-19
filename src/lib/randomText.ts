/**
 * Random-text (ランダム文言) expansion for bulk posting.
 *
 * XBoard spec (docs/xboard-research.md §6-3):
 * - Post text may contain placeholders [Random1] … [Random2000].
 * - At post time, each placeholder is replaced by one entry chosen at
 *   random from that number's registered word list.
 * - Word lists are kept one word per line; URLs are allowed.
 * - A `<br>` inside a chosen word becomes a line break in the post.
 * - Expansion happens per post (and, for scheduled posts, at the
 *   moment the reservation is created).
 *
 * This module is pure and UI-free so the M2 bulk-post engine and the
 * CSV importers can share it.
 */

/** Word lists keyed by placeholder number (1–2000). */
export type RandomWordSets = Readonly<Record<number, readonly string[]>>;

export const RANDOM_MIN = 1;
export const RANDOM_MAX = 2000;

const PLACEHOLDER_RE = /\[Random(\d{1,4})\]/g;

/** Numbers of all [RandomN] placeholders in a text, in order of appearance. */
export function findRandomPlaceholders(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const n = Number(match[1]);
    if (n >= RANDOM_MIN && n <= RANDOM_MAX) found.push(n);
  }
  return found;
}

/**
 * Parse a raw word list (one word per line, as in the random-text CSV)
 * into entries. Blank lines are dropped and surrounding whitespace is
 * trimmed; duplicates are kept out (the CSV spec folds duplicates of
 * the same number into one).
 */
export function parseRandomWords(raw: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const word = line.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

/**
 * Expand every [RandomN] placeholder in `text`.
 *
 * - Each occurrence is an independent random pick.
 * - A placeholder whose number is out of range (not 1–2000) or whose
 *   word list is missing/empty is left untouched, so the problem is
 *   visible in previews instead of silently posting a broken text.
 * - `<br>` in a chosen word is converted to a newline.
 *
 * `rng` is injectable for deterministic tests; it must return [0, 1).
 */
export function expandRandomText(
  text: string,
  sets: RandomWordSets,
  rng: () => number = Math.random,
): string {
  return text.replace(PLACEHOLDER_RE, (whole, digits: string) => {
    const n = Number(digits);
    if (n < RANDOM_MIN || n > RANDOM_MAX) return whole;
    const words = sets[n];
    if (!words || words.length === 0) return whole;
    const idx = Math.min(words.length - 1, Math.floor(rng() * words.length));
    return words[idx].replace(/<br\s*\/?>/gi, '\n');
  });
}
