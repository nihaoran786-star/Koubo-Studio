// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './settings-page'
import type { PublicModelProviderSettings } from '@/lib/model-providers/model-provider-types'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SettingsPage', () => {
  it('can render as the /login model access page without changing provider boundaries', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(baseRuntimeReadinessFixture)
      }

      return jsonResponse({
        status: 'ok',
        source: 'model_provider_store',
        settings: settingsFixture,
      })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage variant="login" />)

    await waitFor(() => expect(screen.getByRole('heading', { name: '登录与模型接入' })).toBeInTheDocument())
    expect(screen.getByText('OpenAI API')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek API')).toBeInTheDocument()
    expect(screen.getByText('ChatGPT 订阅登录')).toBeInTheDocument()
    expect(screen.getByText(/不能直接作为模型 API 凭据/)).toBeInTheDocument()
  })

  it('loads providers from backend settings API and saves provider drafts through PUT', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(runtimeReadinessFixture)
      }

      if (init?.method === 'PUT') {
        return jsonResponse({
          status: 'ok',
          source: 'model_provider_store',
          settings: {
            ...settingsFixture,
            providers: settingsFixture.providers.map((provider) =>
              provider.id === 'openai'
                ? {
                    ...provider,
                    enabled: true,
                    hasApiKey: true,
                    apiKeyPreview: 'sk-t...cret',
                    status: 'configured',
                  }
                : provider,
            ),
          },
        })
      }

      return jsonResponse({
        status: 'ok',
        source: 'model_provider_store',
        settings: settingsFixture,
      })
    })
    const setItem = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('localStorage', { setItem })

    render(<SettingsPage />)

    await waitFor(() => expect(screen.getByText('OpenAI API')).toBeInTheDocument())
    expect(screen.getByText('DeepSeek API')).toBeInTheDocument()
    expect(screen.getByText('待测试')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '测试连接' }).length).toBeGreaterThan(0)
    expect(screen.getAllByText('接入方式：API Key 必填')).toHaveLength(2)
    expect(screen.getByText('接入方式：无需密钥')).toBeInTheDocument()
    expect(screen.getByText('接入方式：API Key 可选')).toBeInTheDocument()
    expect(screen.getByText(/ChatGPT 订阅登录属于账号身份能力/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('生成服务')).toBeInTheDocument())
    expect(screen.getByText('AI 文案 Provider')).toBeInTheDocument()
    expect(screen.getByText('缺少 HEYGEM_API_URL')).toBeInTheDocument()
    await user.click(screen.getByText('HeyGem'))
    expect(screen.getByText('配置 HeyGem。')).toBeInTheDocument()
    expect(screen.queryByText(/P3 ·/)).not.toBeInTheDocument()
    expect(screen.queryByText('复制命令')).not.toBeInTheDocument()

    await user.click(screen.getByText('更换 AI 服务'))
    const openAiProvider = screen.getByRole('region', { name: 'OpenAI API 配置' })
    await user.type(within(openAiProvider).getByLabelText('API Key'), 'sk-test-secret')
    await user.click(within(openAiProvider).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/api/settings/model-providers',
        expect.objectContaining({
          method: 'PUT',
        }),
      ),
    )
    const putCall = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT')
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      providers: [
        {
          id: 'openai',
          apiKey: 'sk-test-secret',
        },
      ],
    })
    expect(setItem).not.toHaveBeenCalled()
  })

  it('shows compact runtime states without governance profiles', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(baseRuntimeReadinessFixture)
      }

      return jsonResponse({
        status: 'ok',
        source: 'model_provider_store',
        settings: settingsFixture,
      })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage />)

    await waitFor(() => expect(screen.getByText('AI 文案 Provider')).toBeInTheDocument())
    expect(screen.getByText('可选未配')).toBeInTheDocument()
    expect(screen.queryByText('基础版')).not.toBeInTheDocument()
    expect(screen.queryByText('完整验收')).not.toBeInTheDocument()
  })

  it('does not expose runtime profile mutation controls', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(baseRuntimeReadinessFixture)
      }

      return jsonResponse({
        status: 'ok',
        source: 'model_provider_store',
        settings: settingsFixture,
      })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage />)

    await waitFor(() => expect(screen.getByText('AI 文案 Provider')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '本地增强版' })).not.toBeInTheDocument()
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false)
  })

  it('从设置页只提交 typed IndexTTS2 本地配置', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(baseRuntimeReadinessFixture)
      }
      return jsonResponse({ status: 'ok', source: 'model_provider_store', settings: settingsFixture })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage />)
    await user.click(await screen.findByText('生成服务'))
    const panel = screen.getByRole('region', { name: 'IndexTTS2 本地配置' })
    await user.clear(within(panel).getByLabelText('Runtime 根目录'))
    await user.type(within(panel).getByLabelText('Runtime 根目录'), 'C:\\IndexTTS2')
    await user.click(within(panel).getByRole('button', { name: '保存声音配置' }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/api/settings/runtime-readiness',
      expect.objectContaining({ method: 'PUT' }),
    ))
    const putCall = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT')
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      localRuntimeConfig: {
        indextts2: {
          ...localRuntimeConfigFixture.indextts2,
          runtimeRoot: 'C:\\IndexTTS2',
        },
      },
    })
  })

  it('从设置页提交 typed Duix 配置且不包含 API key', async () => {
    const user = userEvent.setup()
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes('/api/settings/runtime-readiness')) return jsonResponse(baseRuntimeReadinessFixture)
      return jsonResponse({ status: 'ok', source: 'model_provider_store', settings: settingsFixture })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage />)
    await user.click(await screen.findByText('生成服务'))
    const panel = screen.getByRole('region', { name: 'Duix 数字人配置' })
    await user.click(within(panel).getByLabelText(/高级：自定义兼容 Runtime/))
    await user.type(within(panel).getByLabelText('API 地址'), 'http://127.0.0.1:8383')
    await user.selectOptions(within(panel).getByLabelText('API 协议'), 'duix_face2face')
    await user.click(within(panel).getByRole('button', { name: '保存数字人配置' }))

    await waitFor(() => expect(fetcher.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(true))
    const putCall = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT')
    const body = JSON.parse(String(putCall?.[1]?.body))
    expect(body).toEqual({
      localRuntimeConfig: {
        duixAvatar: {
          ...localRuntimeConfigFixture.duixAvatar,
          mode: 'custom',
          apiUrl: 'http://127.0.0.1:8383',
          apiDialect: 'duix_face2face',
        },
      },
    })
    expect(JSON.stringify(body)).not.toContain('apiKey')
  })

  it('默认展示免 Docker 的 KouboRuntime WSL，并将自定义配置置于高级选项', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/api/settings/runtime-readiness')
      ? jsonResponse(baseRuntimeReadinessFixture)
      : jsonResponse({ status: 'ok', source: 'model_provider_store', settings: settingsFixture }))
    vi.stubGlobal('fetch', fetcher)
    render(<SettingsPage />)
    await userEvent.click(await screen.findByText('生成服务'))
    const panel = screen.getByRole('region', { name: 'Duix 数字人配置' })
    expect(within(panel).getByText(/默认使用 KouboRuntime WSL，无需 Docker/)).toBeInTheDocument()
    expect(within(panel).getByLabelText(/默认：KouboRuntime WSL/)).toBeChecked()
    expect(within(panel).queryByLabelText('API 地址')).not.toBeInTheDocument()
    expect(within(panel).getByLabelText(/高级：自定义兼容 Runtime/)).toBeInTheDocument()
  })

  it('renders local browser publishing preparation and the supervised-submit boundary', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/settings/runtime-readiness')) {
        return jsonResponse(browserPublishRuntimeReadinessFixture)
      }

      return jsonResponse({
        status: 'ok',
        source: 'model_provider_store',
        settings: settingsFixture,
      })
    })
    vi.stubGlobal('fetch', fetcher)

    render(<SettingsPage />)

    await waitFor(() => expect(screen.getByText('抖音 / 小红书发布准备')).toBeInTheDocument())
    await userEvent.click(screen.getByText('抖音 / 小红书发布准备'))

    expect(screen.getByText(/local_publish_package/)).toBeInTheDocument()
    expect(browserPublishRuntimeReadinessFixture.checks[0].nextStep).toContain('最终发布必须由用户监督确认')
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const settingsFixture: PublicModelProviderSettings = {
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
      note: '使用 OpenAI API Key。ChatGPT 订阅登录不等同于 API 凭据。',
    },
    {
      id: 'deepseek',
      kind: 'deepseek',
      name: 'DeepSeek API',
      enabled: false,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      status: 'disabled',
      hasApiKey: false,
      apiKeyPreview: '',
      authMode: 'api_key',
      requiresApiKey: true,
      dataLocation: 'cloud_provider',
      note: '使用 DeepSeek API Key，接口按 OpenAI-compatible 方式测试。',
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
    {
      id: 'custom_openai_compatible',
      kind: 'custom_openai_compatible',
      name: '自定义 OpenAI-compatible',
      enabled: false,
      baseUrl: '',
      model: '',
      status: 'disabled',
      hasApiKey: false,
      apiKeyPreview: '',
      authMode: 'api_key',
      requiresApiKey: false,
      dataLocation: 'custom_endpoint',
      note: '适合私有网关或第三方兼容接口。',
    },
  ],
}

const localRuntimeConfigFixture = {
  indextts2: {
    runtimeRoot: '',
    scriptPath: 'C:\\skills\\Invoke-NaturalTTS.ps1',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    timeoutMs: 180000,
  },
  duixAvatar: {
    mode: 'managed_wsl',
    apiUrl: '',
    apiDialect: 'compatible_render',
    publicAssetBaseUrl: '',
    resultRoot: '',
    hostDataRoot: '',
    containerDataRoot: '',
    scriptPath: '',
    ffprobePath: 'ffprobe',
    timeoutMs: 180000,
    pollIntervalMs: 2000,
  },
}

const runtimeReadinessFixture = {
  status: 'missing',
  source: 'runtime_readiness',
  localRuntimeConfig: localRuntimeConfigFixture,
  profile: {
    id: 'full',
    title: '完整验收',
    description: '要求所有 runtime 前置条件齐备。',
    requiredCheckIds: ['model_provider', 'heygem'],
  },
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
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: [],
      nextStep: '运行 pnpm smoke:model-provider。',
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
        command: 'pnpm smoke:model-provider',
        docPath: 'docs/RUNTIME_PROVISIONING.md#推荐顺序',
      },
    },
    {
      id: 'heygem',
      title: 'HeyGem',
      status: 'missing',
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: ['缺少 HEYGEM_API_URL'],
      nextStep: '配置 HeyGem。',
      provisioning: {
        priority: 3,
        stage: '数字人视频生成',
        required: ['HeyGem API URL 或脚本路径'],
        sensitiveEnvKeys: ['HEYGEM_API_KEY'],
        safeEvidence: '只保留 render artifact id、输出视频路径和非敏感状态。',
      },
      remediation: {
        envKeys: ['RUN_HEYGEM_INTEGRATION', 'HEYGEM_API_URL'],
        envTemplate: 'RUN_HEYGEM_INTEGRATION=1\nHEYGEM_API_URL=http://127.0.0.1:8383',
        command: 'pnpm smoke:heygem-runtime',
        docPath: 'docs/SMOKE_TESTS.md#heygem',
      },
    },
  ],
}

const baseRuntimeReadinessFixture = {
  status: 'ready',
  source: 'runtime_readiness',
  localRuntimeConfig: localRuntimeConfigFixture,
  profile: {
    id: 'base',
    title: '基础版',
    description: '只要求主 App、AI 文案 Provider、workspace 和运行环境提示可用。',
    requiredCheckIds: ['model_provider'],
  },
  updatedAt: '2026-06-12T00:00:00.000Z',
  summary: {
    ready: 1,
    missing: 0,
    warning: 1,
  },
  checks: [
    {
      id: 'model_provider',
      title: 'AI 文案 Provider',
      status: 'ready',
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: [],
      nextStep: '运行 pnpm smoke:model-provider。',
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
        command: 'pnpm smoke:model-provider',
        docPath: 'docs/RUNTIME_PROVISIONING.md#推荐顺序',
      },
    },
    {
      id: 'indextts2',
      title: 'IndexTTS2',
      status: 'warning',
      requiredForCurrentProfile: false,
      optionalForCurrentProfile: true,
      gaps: ['缺少 RUN_INDEXTTS2_INTEGRATION=1'],
      nextStep: '补齐 runtime root 后运行 pnpm smoke:indextts2。',
      provisioning: {
        priority: 2,
        stage: '声音克隆与音频生成',
        required: ['IndexTTS2 runtime root'],
        sensitiveEnvKeys: [],
        safeEvidence: '只保留音频 artifact id 和 smoke 状态。',
      },
      remediation: {
        envKeys: ['RUN_INDEXTTS2_INTEGRATION'],
        envTemplate: 'RUN_INDEXTTS2_INTEGRATION=1',
        command: 'pnpm smoke:indextts2',
        docPath: 'docs/SMOKE_TESTS.md#indextts2',
      },
    },
  ],
}

const browserPublishRuntimeReadinessFixture = {
  status: 'missing',
  source: 'runtime_readiness',
  localRuntimeConfig: localRuntimeConfigFixture,
  profile: {
    id: 'publish_enhanced',
    title: '发布增强版',
    description: '要求本地发布包和本机可见浏览器准备可用。',
    requiredCheckIds: ['browser_publish'],
  },
  updatedAt: '2026-06-12T00:00:00.000Z',
  summary: {
    ready: 0,
    missing: 1,
    warning: 0,
  },
  checks: [
    {
      id: 'browser_publish',
      title: '抖音 / 小红书发布准备',
      status: 'missing',
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: ['缺少 RUN_BROWSER_PUBLISH_PREPARE=1'],
      nextStep: '先生成 local_publish_package；最终发布必须由用户监督确认。',
      provisioning: {
        priority: 6,
        stage: '本地发布准备',
        required: ['local_publish_package', '本机可见浏览器'],
        sensitiveEnvKeys: [],
        safeEvidence: '只保留本地发布包和 manual_required 状态。',
      },
      remediation: {
        envKeys: ['RUN_BROWSER_PUBLISH_PREPARE'],
        envTemplate: 'RUN_BROWSER_PUBLISH_PREPARE=1',
        command: 'pnpm runtime:doctor',
        docPath: 'docs/CONTEXT.md',
      },
    },
  ],
}
