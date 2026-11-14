import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',   // tests/unit/*.test.cjs belongs to `npm run test:unit`
  fullyParallel: false,           // electron app — single instance per test
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    trace: 'retain-on-failure',
  },
  reporter: [['list']],
})
