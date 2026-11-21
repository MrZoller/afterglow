import { defineConfig } from '@playwright/test';

/**
 * Browser tests. Each test starts its own copy of the built app in demo mode (see
 * e2e/fixtures.ts), so tests are independent and can run side by side.
 *
 * Tests tagged @slow wait on real time (a schedule ending, a turn-off check) and take
 * minutes; they run only when E2E_SLOW is set, as CI does.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  grepInvert: process.env.E2E_SLOW ? undefined : /@slow/,
  use: {
    // A phone-sized screen by default; tests that care about desktop set their own.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    colorScheme: 'dark',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
});
