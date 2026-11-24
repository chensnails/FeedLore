import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  outputDir: '../../.build/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    channel: process.env.BROWSER_CHANNEL || undefined,
    viewport: { width: 720, height: 900 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/browser/fixture-server.mjs',
    url: 'http://127.0.0.1:4174/api/version',
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
