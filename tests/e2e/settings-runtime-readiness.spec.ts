import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const screenshotDir = path.join(process.cwd(), 'test-results', 'settings-runtime')

test.afterEach(async () => {
  await fs.rm(screenshotDir, { recursive: true, force: true })
})

test('settings page shows compact runtime readiness from backend API', async ({ page }) => {
  await mockSettingsApis(page)

  await page.goto('/')
  await page.getByRole('button', { name: '设置' }).click()

  await expect(page.getByText('模型接入')).toBeVisible()
  await expect(page.getByText('AI 文案 Provider')).toBeVisible()
  await expect(page.getByText('缺配置')).toBeVisible()
  await page.getByText('HeyGem', { exact: true }).click()
  await expect(page.getByText('缺少 RUN_HEYGEM_INTEGRATION=1').first()).toBeVisible()
  await expect(page.getByText(/配置 HeyGem API 或脚本/)).toBeVisible()
  await expect(page.getByText(/P3 ·/)).toHaveCount(0)

  await takeEvidenceScreenshot(page, 'settings-runtime-readiness.png')
})

async function takeEvidenceScreenshot(page: Page, filename: string) {
  await fs.mkdir(screenshotDir, { recursive: true })
  const filePath = path.join(screenshotDir, filename)
  await page.screenshot({ path: filePath, fullPage: true })
  await expect.poll(async () => fs.stat(filePath).then((stat) => stat.size)).toBeGreaterThan(0)
}

async function mockSettingsApis(page: Page) {
  await page.route('**/api/settings/model-providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'model_provider_store',
        settings: {
          defaultProviderId: 'local_openai_compatible',
          telemetryEnabled: false,
          providers: [
            {
              id: 'openai',
              kind: 'openai',
              name: 'OpenAI API',
              enabled: false,
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-4.1-mini',
              status: 'disabled',
              hasApiKey: false,
              apiKeyPreview: '',
              authMode: 'api_key',
              requiresApiKey: true,
              dataLocation: 'cloud_provider',
              note: '使用 OpenAI API Key。',
            },
            {
              id: 'local_openai_compatible',
              kind: 'local_openai_compatible',
              name: '本地 OpenAI-compatible',
              enabled: true,
              baseUrl: 'http://127.0.0.1:11434/v1',
              model: 'qwen2.5',
              status: 'configured',
              hasApiKey: false,
              apiKeyPreview: '',
              authMode: 'none',
              requiresApiKey: false,
              dataLocation: 'local_only',
              note: '适合本地兼容服务。',
            },
          ],
        },
      }),
    })
  })

  await page.route('**/api/settings/runtime-readiness', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'missing',
        source: 'runtime_readiness',
        profile: runtimeProfileFixture(),
        updatedAt: '2026-06-11T00:00:00.000Z',
        summary: {
          ready: 1,
          missing: 1,
          warning: 0,
        },
        checks: [
          {
            id: 'model_provider',
            title: 'AI 文案 Provider',
            status: 'ready',
            gaps: [],
            nextStep: '打开设置并测试默认 Provider。',
            provisioning: {
              priority: 1,
              stage: '文本智能体 Provider',
              required: ['OpenAI-compatible API endpoint'],
              sensitiveEnvKeys: ['OPENAI_API_KEY'],
              safeEvidence: '只保留脱敏 Provider 状态。',
            },
            remediation: {
              envKeys: [],
              envTemplate: '# 设置页配置',
              command: '打开设置并测试连接',
              docPath: 'docs/RUNTIME_PROVISIONING.md#推荐顺序',
            },
          },
          {
            id: 'heygem',
            title: 'HeyGem',
            status: 'missing',
            gaps: ['缺少 RUN_HEYGEM_INTEGRATION=1'],
            nextStep: '配置 HeyGem API 或脚本、音频输入和 ffprobe 后运行 pnpm smoke:heygem-runtime。',
            provisioning: {
              priority: 3,
              stage: '数字人视频生成',
              required: ['HeyGem API URL 或脚本路径'],
              sensitiveEnvKeys: ['HEYGEM_API_KEY'],
              safeEvidence: '只保留 render artifact id、输出视频路径和非敏感状态。',
            },
            remediation: {
              envKeys: ['RUN_HEYGEM_INTEGRATION', 'HEYGEM_API_URL', 'HEYGEM_INTEGRATION_AUDIO'],
              envTemplate: 'RUN_HEYGEM_INTEGRATION=1\nHEYGEM_API_URL=http://127.0.0.1:8383\nHEYGEM_INTEGRATION_AUDIO=C:\\path\\to\\generated-audio.wav',
              command: 'pnpm smoke:heygem-runtime',
              docPath: 'docs/SMOKE_TESTS.md#heygem',
            },
          },
        ],
      }),
    })
  })
}

function runtimeProfileFixture() {
  return {
    id: 'full',
    title: '完整验收',
    description: '要求所有本地/远程 runtime 和真实 UI evidence 前置条件齐备。',
    requiredCheckIds: ['model_provider', 'heygem'],
  }
}
