import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://127.0.0.1:3102',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || 'pnpm dev --hostname 127.0.0.1 --port 3102',
    url: process.env.PLAYWRIGHT_WEB_SERVER_URL || 'http://127.0.0.1:3102',
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '0' ? false : true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      // Reuse the Windows system browser so local UI checks do not require a
      // second bundled Chromium download on the lightweight desktop install.
      use: { ...devices['Desktop Chrome'], channel: 'msedge' },
    },
  ],
})
