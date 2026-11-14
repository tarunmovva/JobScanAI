import { defineConfig } from '@playwright/test'

// A manual run against the user's REAL Claude Code (it spends their plan),
// never part of `npm run test:e2e` or CI. See smoke.spec.ts for what it
// isolates and what it never touches.
export default defineConfig({
  testDir: '.',
  testMatch: 'smoke.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 45 * 60_000,
  reporter: [['list']],
})
