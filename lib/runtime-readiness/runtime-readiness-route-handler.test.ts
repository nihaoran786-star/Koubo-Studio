import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createDefaultModelProviderSettings,
  writeModelProviderSettings,
} from '@/lib/model-providers/model-provider-store'
import {
  handleRuntimeReadinessGet,
  handleRuntimeReadinessPut,
  probeRuntimeEndpoint,
} from './runtime-readiness-route-handler'

const managedMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
}))

vi.mock('@/lib/managed-runtime/managed-runtime-service', () => ({
  inspectManagedRuntime: managedMocks.inspect,
}))

beforeEach(() => {
  managedMocks.inspect.mockReset()
  managedMocks.inspect.mockResolvedValue(managedReport('absent'))
})

describe('handleRuntimeReadinessGet', () => {
  it('用 Duix /easy/query JSON 协议直连探测，拒绝 HTML、404 和 503', async () => {
    let mode: 'json' | 'json_wrong_type' | 'html' | '404' | '503' = 'json'
    let hits = 0
    const server = createServer((request, response) => {
      hits += 1
      expect(request.url).toBe('/easy/query?code=__koubo_readiness__')
      if (mode === 'json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 10004, msg: 'task not found' }))
      } else if (mode === 'json_wrong_type') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(JSON.stringify({ code: 10004, msg: 'task not found' }))
      } else if (mode === 'html') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html>proxy</html>')
      } else {
        response.writeHead(Number(mode), { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: Number(mode) }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
      const baseUrl = `http://127.0.0.1:${address.port}`
      vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1')
      vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1')

      await expect(probeRuntimeEndpoint(baseUrl, 'duix_face2face', 1000)).resolves.toBe(true)
      mode = 'json_wrong_type'
      await expect(probeRuntimeEndpoint(baseUrl, 'duix_face2face', 1000)).resolves.toBe(true)
      mode = 'html'
      await expect(probeRuntimeEndpoint(baseUrl, 'duix_face2face', 1000)).resolves.toBe(false)
      mode = '404'
      await expect(probeRuntimeEndpoint(baseUrl, 'duix_face2face', 1000)).resolves.toBe(false)
      mode = '503'
      await expect(probeRuntimeEndpoint(baseUrl, 'duix_face2face', 1000)).resolves.toBe(false)
      expect(hits).toBe(5)
    } finally {
      vi.unstubAllEnvs()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('does not report the untested default local Provider as ready on first run', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-first-run-'))
    try {
      const settings = createDefaultModelProviderSettings()
      settings.providers = settings.providers.map((provider) => provider.id === settings.defaultProviderId
        ? { ...provider, enabled: true, apiKey: 'test-only-key', status: 'configured' }
        : provider)
      await writeModelProviderSettings(settings, { root: path.join(temp, 'data', 'settings') })
      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {},
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        status: 'missing',
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'model_provider',
            status: 'missing',
            gaps: ['默认 AI Provider 尚未验证连接。'],
            nextStep: '打开设置，测试默认 Provider 连接。',
          }),
        ]),
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('reports an unreachable default Provider separately from missing setup', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-unreachable-'))
    try {
      const settings = createDefaultModelProviderSettings()
      settings.providers = settings.providers.map((provider) =>
        provider.id === settings.defaultProviderId
          ? {
              ...provider,
              enabled: true,
              apiKey: 'test-only-key',
              status: 'network_error',
              lastTestedAt: '2026-07-16T00:00:00.000Z',
              lastError: {
                code: 'network_error',
                message: '无法连接 Provider。',
              },
            }
          : provider,
      )
      await writeModelProviderSettings(settings, {
        root: path.join(temp, 'data', 'settings'),
      })

      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {},
        probeProvider: async (provider) => ({
          status: 'network_error',
          source: 'model_provider_test',
          providerId: provider.id,
          testedAt: '2026-07-16T00:01:00.000Z',
          error: {
            code: 'network_error',
            message: '无法连接 Provider。',
          },
        }),
      })

      await expect(response.json()).resolves.toMatchObject({
        status: 'missing',
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'model_provider',
            status: 'missing',
            gaps: ['默认 AI Provider 当前不可达。'],
            nextStep: '打开设置，检查服务或网络后重新测试连接。',
          }),
        ]),
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('rechecks only the previously connected default Provider with an injectable probe', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-connected-probe-'))
    try {
      const settings = createDefaultModelProviderSettings()
      settings.providers = settings.providers.map((provider) => ({
        ...provider,
        enabled: true,
        status: 'connected',
        lastTestedAt: '2026-07-16T00:00:00.000Z',
        ...(provider.kind === 'openai' || provider.kind === 'deepseek'
          ? { apiKey: 'test-only-key' }
          : {}),
      }))
      await writeModelProviderSettings(settings, {
        root: path.join(temp, 'data', 'settings'),
      })
      const probedProviderIds: string[] = []

      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {},
        probeProvider: async (provider) => {
          probedProviderIds.push(provider.id)
          return {
            status: 'network_error',
            source: 'model_provider_test',
            providerId: provider.id,
            testedAt: '2026-07-16T00:01:00.000Z',
            error: {
              code: 'network_error',
              message: '无法连接 Provider。',
            },
          }
        },
      })

      expect(probedProviderIds).toEqual([settings.defaultProviderId])
      await expect(response.json()).resolves.toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'model_provider',
            status: 'missing',
            gaps: ['默认 AI Provider 当前不可达。'],
          }),
        ]),
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('reports the default Provider as ready only after the connection probe succeeds', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-connected-'))
    try {
      const settings = createDefaultModelProviderSettings()
      settings.providers = settings.providers.map((provider) =>
        provider.id === settings.defaultProviderId
          ? {
              ...provider,
              enabled: true,
              apiKey: 'test-only-key',
              status: 'connected',
              lastTestedAt: '2026-07-16T00:00:00.000Z',
            }
          : provider,
      )
      await writeModelProviderSettings(settings, {
        root: path.join(temp, 'data', 'settings'),
      })

      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {},
        probeProvider: async (provider) => ({
          status: 'connected',
          source: 'model_provider_test',
          providerId: provider.id,
          testedAt: '2026-07-16T00:01:00.000Z',
        }),
      })

      await expect(response.json()).resolves.toMatchObject({
        status: 'ready',
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'model_provider',
            status: 'ready',
            gaps: [],
          }),
        ]),
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('does not let legacy Provider environment variables override the selected default Provider', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-default-only-'))
    try {
      const settings = createDefaultModelProviderSettings()
      settings.defaultProviderId = 'openai'
      await writeModelProviderSettings(settings, {
        root: path.join(temp, 'data', 'settings'),
      })

      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {
          MODEL_PROVIDER_BASE_URL: 'http://legacy-provider.example/v1',
          OPENAI_API_KEY: 'legacy-key',
        },
      })

      await expect(response.json()).resolves.toMatchObject({
        status: 'missing',
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'model_provider',
            status: 'missing',
            gaps: ['默认 AI Provider 尚未完成配置。'],
            nextStep: '打开设置，启用并配置默认 Provider。',
          }),
        ]),
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('returns structured readiness checks', async () => {
    const response = await handleRuntimeReadinessGet({
      detectReadiness: () => ({
        status: 'missing',
        source: 'runtime_readiness',
        profile: {
          id: 'full',
          title: '完整验收',
          description: '要求所有 runtime 前置条件齐备。',
          requiredCheckIds: ['model_provider', 'heygem'],
        },
        updatedAt: '2026-06-11T00:00:00.000Z',
        summary: { ready: 1, missing: 1, warning: 0 },
        checks: [
          {
            id: 'model_provider',
            title: 'AI 文案 Provider',
            status: 'ready',
            requiredForCurrentProfile: true,
            optionalForCurrentProfile: false,
            gaps: [],
            nextStep: '运行 smoke。',
            provisioning: {
              priority: 1,
              stage: '文本智能体 Provider',
              required: ['OpenAI-compatible API endpoint'],
              sensitiveEnvKeys: ['OPENAI_API_KEY'],
              safeEvidence: '只保留脱敏状态。',
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
              required: ['HeyGem API URL'],
              sensitiveEnvKeys: ['HEYGEM_API_KEY'],
              safeEvidence: '只保留 render artifact。',
            },
            remediation: {
              envKeys: ['RUN_HEYGEM_INTEGRATION', 'HEYGEM_API_URL'],
              envTemplate: 'RUN_HEYGEM_INTEGRATION=1\nHEYGEM_API_URL=http://127.0.0.1:8383',
              command: 'pnpm smoke:heygem-runtime',
              docPath: 'docs/SMOKE_TESTS.md#heygem',
            },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'missing',
      source: 'runtime_readiness',
      summary: {
        missing: 1,
      },
    })
  })

  it('returns stable error payloads', async () => {
    const response = await handleRuntimeReadinessGet({
      detectReadiness: () => {
        throw new Error('boom')
      },
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      status: 'error',
      source: 'runtime_readiness',
      error: {
        code: 'runtime_readiness_error',
      },
    })
  })

  it('probes configured runtime endpoints before detection', async () => {
    const probed: string[] = []
    const response = await handleRuntimeReadinessGet({
      runtimeEnv: { DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383' },
      probeEndpoint: async (url) => {
        probed.push(url)
        return false
      },
      detectReadiness: ({ endpointReachable }) => {
        expect(endpointReachable('http://127.0.0.1:8383')).toBe(false)
        return readinessForProfile('base')
      },
    })
    expect(response.status).toBe(200)
    expect(probed).toEqual(['http://127.0.0.1:8383'])
  })

  it('injects managed runtime readiness into GET without starting it', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-managed-ready-'))
    managedMocks.inspect.mockResolvedValue(managedReport('ready'))
    try {
      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {
          KOUBO_RUNTIME_PROFILE: 'local_enhanced',
        },
        probeEndpoint: async () => false,
      })
      const body = await response.json()

      expect(managedMocks.inspect).toHaveBeenCalledTimes(1)
      expect(body.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'heygem', status: 'ready', gaps: [] }),
      ]))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('PUT only inspects managed runtime after saving settings', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-managed-put-'))
    managedMocks.inspect.mockResolvedValue(managedReport('stopped'))
    try {
      const response = await handleRuntimeReadinessPut(
        new Request('http://localhost/api/settings/runtime-readiness', {
          method: 'PUT',
          body: JSON.stringify({ profileId: 'base' }),
        }),
        { root: temp },
      )

      expect(response.status).toBe(200)
      expect(managedMocks.inspect).toHaveBeenCalledTimes(1)
      const body = await response.json()
      expect(body.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'heygem', status: 'warning' }),
      ]))
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('loads local runtime configuration without exposing its values', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-env-route-'))
    try {
      writeFileSync(path.join(temp, '.env.runtime.local'), 'INDEXTTS2_RUNTIME_ROOT=C:\\runtime\n')
      const response = await handleRuntimeReadinessGet({
        root: temp,
        detectReadiness: ({ env }) => {
          expect(env.INDEXTTS2_RUNTIME_ROOT).toBe('C:\\runtime')
          return readinessForProfile('base')
        },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        localRuntimeConfig: {
          indextts2: {
            runtimeRoot: 'C:\\runtime',
            ffmpegPath: 'ffmpeg',
            ffprobePath: 'ffprobe',
            timeoutMs: 180000,
          },
        },
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('GET 不返回 Duix API key', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-duix-key-route-'))
    try {
      const response = await handleRuntimeReadinessGet({
        root: temp,
        runtimeEnv: {
          DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
          DUIX_AVATAR_API_KEY: 'super-secret-key',
        },
        probeEndpoint: async () => false,
        detectReadiness: () => readinessForProfile('base'),
      })
      const body = await response.json()
      expect(body.localRuntimeConfig.duixAvatar.apiUrl).toBe('http://127.0.0.1:8383')
      expect(JSON.stringify(body)).not.toContain('super-secret-key')
      expect(body.localRuntimeConfig.duixAvatar).not.toHaveProperty('apiKey')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('persists the selected runtime profile and uses it for readiness detection', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-readiness-route-'))
    try {
      const putResponse = await handleRuntimeReadinessPut(
        new Request('http://localhost/api/settings/runtime-readiness', {
          method: 'PUT',
          body: JSON.stringify({ profileId: 'base' }),
        }),
        {
          root: temp,
          detectReadiness: ({ env }) => ({
            ...readinessForProfile(env.KOUBO_RUNTIME_PROFILE),
          }),
        },
      )

      expect(putResponse.status).toBe(200)
      await expect(putResponse.json()).resolves.toMatchObject({
        status: 'ready',
        profile: {
          id: 'base',
        },
      })

      const getResponse = await handleRuntimeReadinessGet({
        root: temp,
        detectReadiness: ({ env }) => ({
          ...readinessForProfile(env.KOUBO_RUNTIME_PROFILE),
        }),
      })

      await expect(getResponse.json()).resolves.toMatchObject({
        profile: {
          id: 'base',
        },
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('rejects invalid runtime profiles', async () => {
    const response = await handleRuntimeReadinessPut(
      new Request('http://localhost/api/settings/runtime-readiness', {
        method: 'PUT',
        body: JSON.stringify({ profileId: 'heavy_everything' }),
      }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'error',
      source: 'runtime_readiness',
      error: {
        code: 'invalid_runtime_profile',
      },
    })
  })

  it('保存 IndexTTS2 配置且不覆盖已选 profile', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-config-route-'))
    try {
      await handleRuntimeReadinessPut(new Request('http://localhost/api/settings/runtime-readiness', {
        method: 'PUT',
        body: JSON.stringify({ profileId: 'local_enhanced' }),
      }), { root: temp })

      const response = await handleRuntimeReadinessPut(new Request('http://localhost/api/settings/runtime-readiness', {
        method: 'PUT',
        body: JSON.stringify({
          localRuntimeConfig: {
            indextts2: {
              runtimeRoot: 'C:\\IndexTTS2',
              scriptPath: 'C:\\scripts\\Invoke-NaturalTTS.ps1',
              ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
              ffprobePath: 'C:\\ffmpeg\\ffprobe.exe',
              timeoutMs: 240000,
            },
          },
        }),
      }), { root: temp })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        profile: { id: 'local_enhanced' },
        localRuntimeConfig: {
          indextts2: {
            runtimeRoot: 'C:\\IndexTTS2',
            timeoutMs: 240000,
          },
        },
      })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('拒绝未知和非法的本地运行配置', async () => {
    const unknown = await handleRuntimeReadinessPut(new Request('http://localhost/api/settings/runtime-readiness', {
      method: 'PUT',
      body: JSON.stringify({ localRuntimeConfig: { remoteApi: { url: 'http://example.com' } } }),
    }))
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: 'invalid_runtime_config' } })

    const illegal = await handleRuntimeReadinessPut(new Request('http://localhost/api/settings/runtime-readiness', {
      method: 'PUT',
      body: JSON.stringify({ localRuntimeConfig: { indextts2: { timeoutMs: 10 } } }),
    }))
    expect(illegal.status).toBe(400)
    await expect(illegal.json()).resolves.toMatchObject({ error: { code: 'invalid_runtime_config' } })
  })
})

function readinessForProfile(profileId: string | undefined) {
  expect(profileId).toBe('base')
  return {
    status: 'ready' as const,
    source: 'runtime_readiness' as const,
    profile: {
      id: 'base' as const,
      title: '基础版',
      description: '基础版 profile',
      requiredCheckIds: ['model_provider'],
    },
    updatedAt: '2026-06-12T00:00:00.000Z',
    summary: { ready: 1, missing: 0, warning: 0 },
    checks: [],
  }
}

function managedReport(status: 'absent' | 'stopped' | 'ready') {
  return {
    status,
    source: 'managed_runtime_probe' as const,
    checkedAt: '2026-07-17T00:00:00.000Z',
    runtime: {
      name: 'KouboRuntime' as const,
      installed: status !== 'absent',
      distroState: status === 'absent' ? 'absent' as const : status === 'stopped' ? 'stopped' as const : 'running' as const,
      wslVersion: status === 'absent' ? null : 2,
      version: status === 'ready' ? '1.0.0' : null,
      apiUrl: 'http://127.0.0.1:8383' as const,
      health: status === 'ready' ? 'healthy' as const : 'not_checked' as const,
    },
    actions: {
      canImport: status === 'absent',
      canStart: status === 'stopped',
      canStop: status === 'ready',
      canUninstall: status !== 'absent',
    },
    error: null,
  }
}
