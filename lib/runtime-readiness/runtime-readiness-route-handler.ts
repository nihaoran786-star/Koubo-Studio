import { NextResponse } from 'next/server'
import path from 'node:path'
import { readModelProviderSettings } from '@/lib/model-providers/model-provider-store'
import { testModelProviderConnection } from '@/lib/model-providers/model-provider-test-service'
import type {
  ProviderConnectionTestResult,
  StoredModelProvider,
} from '@/lib/model-providers/model-provider-types'
import {
  detectRuntimeReadiness,
  type ModelProviderReadinessState,
} from './runtime-readiness-service'
import {
  isRuntimeProfileId,
  readRuntimeSettings,
  writeRuntimeSettings,
} from './runtime-settings-store'
import type {
  RuntimeReadinessResult,
  RuntimeReadinessUpdateInput,
} from './runtime-readiness-types'
import {
  localRuntimeConfigToEnv,
  readDevelopmentRuntimeEnv,
  resolveLocalRuntimeConfig,
  RuntimeConfigStoreError,
  updateLocalRuntimeConfig,
  validateLocalRuntimeConfigPatch,
} from '@/lib/runtime-data/runtime-config-store'
import { inspectManagedRuntime } from '@/lib/managed-runtime/managed-runtime-service'
import type { ManagedRuntimeReport } from '@/lib/managed-runtime/managed-runtime-types'

type ProviderProbe = (provider: StoredModelProvider) => Promise<ProviderConnectionTestResult>

interface RuntimeReadinessHandlerOptions {
  root?: string
  runtimeEnv?: Record<string, string | undefined>
  probeEndpoint?: (url: string, dialect?: 'compatible_render' | 'duix_face2face') => Promise<boolean>
  detectReadiness?: (input: {
    env: NodeJS.ProcessEnv
    endpointReachable: (url: string) => boolean
    providerState: ModelProviderReadinessState
    managedRuntimeStatus: ManagedRuntimeReport['status']
  }) => Omit<RuntimeReadinessResult, 'localRuntimeConfig'>
  inspectManagedRuntime?: () => Promise<ManagedRuntimeReport>
  probeProvider?: ProviderProbe
  providerProbeTimeoutMs?: number
}

export async function handleRuntimeReadinessGet(options: RuntimeReadinessHandlerOptions = {}) {
  try {
    const { env, localRuntimeConfig, providerState } = await buildRuntimeReadinessContext(options)
    const managedRuntime = await (options.inspectManagedRuntime ?? inspectManagedRuntime)()
    const endpointReachable = await probeConfiguredEndpoints(env, options.probeEndpoint)
    const result = options.detectReadiness
      ? options.detectReadiness({
          env,
          endpointReachable,
          providerState,
          managedRuntimeStatus: managedRuntime.status,
        })
      : detectRuntimeReadiness({
          env,
          endpointReachable,
          providerState,
          managedRuntimeStatus: managedRuntime.status,
        })
    return NextResponse.json({ ...result, localRuntimeConfig }, { status: 200 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'error',
        source: 'runtime_readiness',
        summary: { ready: 0, missing: 0, warning: 0 },
        checks: [],
        error: {
          code: 'runtime_readiness_error',
          message,
        },
      },
      { status: 500 },
    )
  }
}

export async function handleRuntimeReadinessPut(
  request: Request,
  options: RuntimeReadinessHandlerOptions = {},
) {
  try {
    const body = (await request.json()) as RuntimeReadinessUpdateInput
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalidRequest('invalid_runtime_request', '运行环境设置必须是对象。')
    }
    const unknownKeys = Object.keys(body).filter((key) => key !== 'profileId' && key !== 'localRuntimeConfig')
    if (unknownKeys.length > 0) {
      return invalidRequest('invalid_runtime_request', `运行环境设置包含未知字段：${unknownKeys.join(', ')}。`)
    }
    if (body.profileId === undefined && body.localRuntimeConfig === undefined) {
      return invalidRequest('invalid_runtime_request', '没有可保存的运行环境设置。')
    }
    if (body.profileId !== undefined && !isRuntimeProfileId(body.profileId)) {
      return NextResponse.json(
        {
          status: 'error',
          source: 'runtime_readiness',
          error: {
            code: 'invalid_runtime_profile',
            message: '运行环境 profile 无效。',
          },
        },
        { status: 400 },
      )
    }

    const configPatch = body.localRuntimeConfig === undefined
      ? undefined
      : validateLocalRuntimeConfigPatch(body.localRuntimeConfig)
    if (configPatch) await updateLocalRuntimeConfig(configPatch, { root: options.root })
    if (body.profileId !== undefined) {
      await writeRuntimeSettings({ profileId: body.profileId }, { root: options.root })
    }
    const { env, localRuntimeConfig, providerState } = await buildRuntimeReadinessContext(options)
    const managedRuntime = await (options.inspectManagedRuntime ?? inspectManagedRuntime)()
    const endpointReachable = await probeConfiguredEndpoints(env, options.probeEndpoint)
    const result = options.detectReadiness
      ? options.detectReadiness({
          env,
          endpointReachable,
          providerState,
          managedRuntimeStatus: managedRuntime.status,
        })
      : detectRuntimeReadiness({
          env,
          endpointReachable,
          providerState,
          managedRuntimeStatus: managedRuntime.status,
        })
    return NextResponse.json({ ...result, localRuntimeConfig }, { status: 200 })
  } catch (error) {
    if (error instanceof RuntimeConfigStoreError && error.code === 'invalid_runtime_config') {
      return invalidRequest(error.code, error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'error',
        source: 'runtime_readiness',
        error: {
          code: 'runtime_readiness_error',
          message,
        },
      },
      { status: 500 },
    )
  }
}

async function buildRuntimeReadinessContext(options: RuntimeReadinessHandlerOptions) {
  const settings = await readRuntimeSettings({ root: options.root })
  const providerSettings = await readModelProviderSettings(
    options.root ? { root: path.join(options.root, 'data', 'settings') } : {},
  )
  const defaultProvider = providerSettings.providers.find(
    (provider) => provider.id === providerSettings.defaultProviderId,
  )
  let providerState: ModelProviderReadinessState = !defaultProvider ||
    !defaultProvider.enabled ||
    !defaultProvider.baseUrl?.trim() ||
    !defaultProvider.model?.trim() ||
    ((defaultProvider.kind === 'openai' || defaultProvider.kind === 'deepseek') && !defaultProvider.apiKey?.trim())
    ? 'needs_setup'
    : defaultProvider.status === 'connected'
      ? 'connected'
      : defaultProvider.status === 'network_error' || defaultProvider.status === 'runtime_error'
        ? 'unreachable'
        : 'unverified'
  if (
    defaultProvider?.lastTestedAt &&
    (providerState === 'connected' || providerState === 'unreachable') &&
    (Boolean(options.probeProvider) || !options.detectReadiness)
  ) {
    const probe = options.probeProvider ?? ((provider: StoredModelProvider) =>
      testModelProviderConnection({
        provider,
        timeoutMs: options.providerProbeTimeoutMs ?? 1500,
      }))
    const result = await probe(defaultProvider)
    providerState = result.status === 'connected'
      ? 'connected'
      : result.status === 'network_error' || result.status === 'runtime_error'
        ? 'unreachable'
        : 'needs_setup'
  }
  const developmentRoot = process.env.NODE_ENV === 'production'
    ? undefined
    : options.root ?? process.cwd()
  const developmentEnv = developmentRoot
    ? await readDevelopmentRuntimeEnv(developmentRoot)
    : {}
  const localRuntimeConfig = await resolveLocalRuntimeConfig({
    root: options.root,
    developmentRoot,
    injectedEnv: options.runtimeEnv,
  })
  return {
    localRuntimeConfig,
    providerState,
    env: {
    ...developmentEnv,
    ...process.env,
    ...options.runtimeEnv,
    ...localRuntimeConfigToEnv(localRuntimeConfig),
    KOUBO_RUNTIME_PROFILE: settings.profileId,
    },
  }
}

function invalidRequest(code: 'invalid_runtime_request' | 'invalid_runtime_config', message: string) {
  return NextResponse.json({
    status: 'error',
    source: 'runtime_readiness',
    error: { code, message },
  }, { status: 400 })
}

async function probeConfiguredEndpoints(env: NodeJS.ProcessEnv, probe = probeRuntimeEndpoint) {
  const endpoints = [
    { url: env.INDEXTTS2_API_URL?.trim(), dialect: 'compatible_render' as const },
    {
      url: env.DUIX_AVATAR_API_URL?.trim() || env.HEYGEM_API_URL?.trim(),
      dialect: (env.DUIX_AVATAR_API_DIALECT?.trim() || env.HEYGEM_API_DIALECT?.trim()) === 'duix_face2face'
        ? 'duix_face2face' as const
        : 'compatible_render' as const,
    },
  ].filter((item): item is { url: string; dialect: 'compatible_render' | 'duix_face2face' } =>
    Boolean(item.url && /^https?:\/\//i.test(item.url)))
  const unique = [...new Map(endpoints.map((item) => [item.url, item])).values()]
  const results = new Map(await Promise.all(unique.map(async ({ url, dialect }) => [url, await probe(url, dialect)] as const)))
  return (url: string) => results.get(url) === true
}

export async function probeRuntimeEndpoint(
  value: string,
  dialect: 'compatible_render' | 'duix_face2face' = 'compatible_render',
  timeoutMs = 3000,
) {
  try {
    const baseUrl = new URL(value)
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') return false
    const target = dialect === 'duix_face2face'
      ? new URL('/easy/query?code=__koubo_readiness__', `${baseUrl.toString().replace(/\/$/, '')}/`)
      : new URL('/health', `${baseUrl.toString().replace(/\/$/, '')}/`)
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = JSON.parse(await response.text()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false
    const record = body as Record<string, unknown>
    if (dialect === 'duix_face2face') {
      return typeof record.code === 'number' || (record.data !== null && typeof record.data === 'object')
    }
    return record.status === 'ok' || record.status === 'ready' || record.ok === true || record.success === true || typeof record.code === 'number'
  } catch {
    return false
  }
}
