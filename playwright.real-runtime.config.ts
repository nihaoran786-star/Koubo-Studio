import { defineConfig, devices } from '@playwright/test'

const frontendUrl = process.env.REAL_RUNTIME_UI_PLAYWRIGHT_FRONTEND_URL || 'http://127.0.0.1:3112'
const backendUrl = process.env.NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL || ''
const frontendPort = new URL(frontendUrl).port || '3112'
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1'
const webServerCommand = process.platform === 'win32' && backendUrl
  ? `set NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL=${backendUrl}&& pnpm dev --hostname 127.0.0.1 --port ${frontendPort}`
  : backendUrl
    ? `NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL="${backendUrl}" pnpm dev --hostname 127.0.0.1 --port ${frontendPort}`
    : `pnpm dev --hostname 127.0.0.1 --port ${frontendPort}`

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: frontendUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: webServerCommand,
    url: frontendUrl,
    reuseExistingServer,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
