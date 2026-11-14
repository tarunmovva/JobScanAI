import { defineConfig } from '@playwright/test'

// Separate from the e2e suite on purpose: these specs only take pictures for
// the README, so `npm run test:e2e` and CI never run them.
export default defineConfig({
  testDir: '.',
  testMatch: 'readme-screenshots.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
})
