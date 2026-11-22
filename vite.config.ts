import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Build-time version info, shown in the sidebar and Settings so a
  // test run can confirm the running app contains the latest fixes.
  // NOTE: values are read when the dev server / build starts, so after
  // a `git pull` restart the dev server for the display to update.
  define: {
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
