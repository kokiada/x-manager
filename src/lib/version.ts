/**
 * Build-time version info, injected by vite.config.ts (`define`).
 * Shown in the sidebar and Settings so a test run can confirm the
 * running app actually contains the latest fixes: compare the commit
 * shown here with the remote main HEAD. A stale build (e.g. the old
 * Electron shell serving its bundled dist) shows its old commit.
 */

/** Short commit hash from the build, or 'dev' when git is unavailable. */
export const APP_COMMIT: string =
  typeof __APP_COMMIT__ === 'string' && __APP_COMMIT__ ? __APP_COMMIT__ : 'dev';

/** ISO build timestamp from the build, or '' when unavailable. */
export const APP_BUILD_TIME: string =
  typeof __APP_BUILD_TIME__ === 'string' ? __APP_BUILD_TIME__ : '';

/** 'M/D HH:MM' in local time, or '' when the input is empty/invalid. */
export function formatBuildTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Sidebar label, e.g. `a156374 · 11/22 11:52`. */
export function versionLabel(): string {
  const t = formatBuildTime(APP_BUILD_TIME);
  return t ? `${APP_COMMIT} · ${t}` : APP_COMMIT;
}
