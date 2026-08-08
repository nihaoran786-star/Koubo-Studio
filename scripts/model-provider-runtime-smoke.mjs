import { fileURLToPath } from 'node:url'

const DEFAULT_PROJECT_ID = 'model-provider-smoke'
const DEFAULT_MESSAGE = '生成一条 30 秒 AI 编程入门口播文案，面向第一次使用 AI 编程工具的新手。'
const DEFAULT_TIMEOUT_MS = 120000

export function readModelProviderSmokeConfig(env = process.env) {
  const timeoutMs = Number(env.MODEL_PROVIDER_SMOKE_TIMEOUT_MS)
  const providerId = (env.MODEL_PROVIDER_SMOKE_PROVIDER_ID || '').trim()
  return {
    enabled: env.RUN_MODEL_PROVIDER_SMOKE === '1',
    backendUrl: (env.MODEL_PROVIDER_SMOKE_BACKEND_URL || env.DESKTOP_LOCAL_BACKEND_URL || '')
      .trim()
      .replace(/\/+$/, ''),
    projectId: (env.MODEL_PROVIDER_SMOKE_PROJECT_ID || DEFAULT_PROJECT_ID).trim() || DEFAULT_PROJECT_ID,
    message: (env.MODEL_PROVIDER_SMOKE_MESSAGE || DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    configureProvider: env.MODEL_PROVIDER_SMOKE_CONFIGURE_PROVIDER === '1',
    provider: providerId ? {
      id: providerId,
      enabled: env.MODEL_PROVIDER_SMOKE_PROVIDER_ENABLED !== '0',
      baseUrl: (env.MODEL_PROVIDER_SMOKE_BASE_URL || '').trim(),
      model: (env.MODEL_PROVIDER_SMOKE_MODEL || '').trim(),
      apiKey: env.MODEL_PROVIDER_SMOKE_API_KEY,
    } : undefined,
  }
}

export async function runModelProviderRuntimeSmoke({ env = process.env, fetcher = fetch, logger = console } = {}) {
  const config = readModelProviderSmokeConfig(env)
  if (!config.enabled) {
    logger.log('Model Provider smoke skipped. Set RUN_MODEL_PROVIDER_SMOKE=1 to enable.')
    return { status: 'skipped', reason: 'disabled' }
  }
  if (!isUsableHttpUrl(config.backendUrl)) {
    return fail(logger, 'invalid_backend_url', 'MODEL_PROVIDER_SMOKE_BACKEND_URL 必须是可用的应用后端地址。')
  }
  if (config.configureProvider) {
    const error = validateProvider(config.provider)
    if (error) return fail(logger, error.code, error.message)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    if (config.configureProvider && config.provider) {
      const saved = await requestJson(fetcher, `${config.backendUrl}/api/settings/model-providers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ defaultProviderId: config.provider.id, providers: [config.provider] }),
      })
      if (!saved.ok) return fail(logger, 'provider_settings_failed', saved.message)
    }

    const settings = await requestJson(fetcher, `${config.backendUrl}/api/settings/model-providers`, {
      method: 'GET', signal: controller.signal,
    })
    const defaultProviderId = settings.payload.settings?.defaultProviderId
    if (!settings.ok || !defaultProviderId) {
      return fail(logger, 'no_default_provider', settings.message || '未找到默认 AI Provider。')
    }

    const tested = await requestJson(fetcher, `${config.backendUrl}/api/settings/model-providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ providerId: defaultProviderId }),
    })
    if (!tested.ok || tested.payload.status !== 'ok') {
      return fail(
        logger,
        tested.payload.result?.error?.code || tested.payload.error?.code || 'provider_test_failed',
        tested.payload.result?.error?.message || tested.payload.error?.message || tested.message,
      )
    }

    const generated = await requestJson(
      fetcher,
      `${config.backendUrl}/api/projects/${encodeURIComponent(config.projectId)}/script-agent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message: config.message, approvalStatus: 'draft' }),
      },
    )
    const artifact = generated.payload.artifact
    if (!generated.ok || generated.payload.status !== 'ok' || !artifact?.artifactId || !artifact?.content?.title || !artifact?.content?.body) {
      return fail(
        logger,
        generated.payload.error?.code || 'script_artifact_invalid',
        generated.payload.error?.message || generated.message || '文案 Provider 未返回有效文案。',
      )
    }

    logger.log(`Model Provider smoke passed: ${defaultProviderId} / ${artifact.artifactId}`)
    return { status: 'ok', providerId: defaultProviderId, artifactId: artifact.artifactId }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError'
    return fail(
      logger,
      timedOut ? 'model_provider_smoke_timeout' : 'model_provider_smoke_failed',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    clearTimeout(timeout)
  }
}

function validateProvider(provider) {
  if (!provider) return { code: 'missing_provider_id', message: '配置 Provider 时必须提供 Provider ID。' }
  if (!provider.baseUrl || !provider.model) return { code: 'missing_provider_config', message: 'Provider 地址和模型不能为空。' }
  if (!isUsableHttpUrl(provider.baseUrl)) return { code: 'invalid_provider_base_url', message: 'Provider 地址无效。' }
  if ([provider.id, provider.model, provider.apiKey].some(isPlaceholderValue)) {
    return { code: 'placeholder_provider_config', message: 'Provider 配置仍包含模板占位值。' }
  }
}

async function requestJson(fetcher, url, init) {
  const response = await fetcher(url, init)
  let payload = {}
  try { payload = await response.json() } catch {}
  return { ok: response.ok, payload, message: payload.error?.message || `HTTP ${response.status}` }
}

function fail(logger, code, message) {
  logger.error(`Model Provider smoke failed (${code}): ${message}`)
  return { status: 'failed', error: { code, message } }
}

function isUsableHttpUrl(value) {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !isPlaceholderValue(url.hostname)
  } catch { return false }
}

function isPlaceholderValue(value) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return false
  return normalized.startsWith('replace-with-') || normalized.startsWith('your-') ||
    ['changeme', 'change-me', 'placeholder', 'dummy', 'example'].includes(normalized)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runModelProviderRuntimeSmoke()
  if (result.status === 'failed') process.exitCode = 1
}
