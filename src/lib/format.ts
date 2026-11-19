/** Compact number formatting for counts (12,480 → "12.5K"). */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString('ja-JP');
}

export function fullCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** "2026-11-20 09:41" style timestamp, or "—" when never checked. */
export function checkedAtLabel(ts?: number): string {
  if (!ts) return '未チェック';
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Mask an auth token for display: first 4 chars + bullets. Never show it in full. */
export function maskToken(token?: string): string {
  if (!token) return '未登録';
  if (token.length <= 4) return '••••';
  return `${token.slice(0, 4)}••••••••`;
}
