import { fileURLToPath } from 'node:url'

const DEFAULT_PROJECT_ID = 'desktop-smoke'
const DEFAULT_TIMEOUT_MS = 5000
const REQUIRED_CAPABILITIES = [
  'script_agent',
  'audio_agent',
  'digital_human',
  'post_production',
  'publish_agent',
]

export function readDesktopBackendSmokeConfig(env = process.env) {
  const enabled = env.RUN_DESKTOP_BACKEND_SMOKE === '1'
  const backendUrl = (env.DESKTOP_LOCAL_BACKEND_URL || env.NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL || '')
    .trim()
    .replace(/\/+$/, '')
  const timeoutMs = Number(env.DESKTOP_LOCAL_BACKEND_TIMEOUT_MS)

  return {
    enabled,
    backendUrl,
    projectId: (env.DESKTOP_SMOKE_PROJECT_ID || DEFAULT_PROJECT_ID).trim() || DEFAULT_PROJECT_ID,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

export async function runDesktopBackendSmoke({
  env = process.env,
  fetcher = fetch,
  logger = console,
} = {}) {
  const config = readDesktopBackendSmokeConfig(env)

  if (!config.enabled) {
    logger.log('Desktop local backend smoke skipped. Set RUN_DESKTOP_BACKEND_SMOKE=1 to enable.')
    return {
      status: 'skipped',
      reason: 'disabled',
    }
  }

  if (!config.backendUrl) {
    logger.error('Desktop local backend smoke failed: DESKTOP_LOCAL_BACKEND_URL is required.')
    return {
      status: 'failed',
      error: {
        code: 'desktop_backend_missing',
        message: 'DESKTOP_LOCAL_BACKEND_URL is required.',
      },
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  const endpoint = `${config.backendUrl}/api/projects/${encodeURIComponent(config.projectId)}/desktop-runtime`

  try {
    const response = await fetcher(endpoint, {
      method: 'GET',
      signal: controller.signal,
    })
    const payload = await response.json()

    if (!response.ok || payload.status !== 'available') {
      logger.error(`Desktop local backend smoke failed: ${payload.error?.message || `HTTP ${response.status}`}`)
      return {
        status: 'failed',
        error: {
          code: payload.error?.code || 'desktop_backend_unreachable',
          message: payload.error?.message || `HTTP ${response.status}`,
        },
      }
    }

    const missingCapabilities = missingRequiredCapabilities(payload.capabilities)
    if (missingCapabilities.length > 0) {
      const message = `Desktop local backend is missing capabilities: ${missingCapabilities.join(', ')}`
      logger.error(`Desktop local backend smoke failed: ${message}`)
      return {
        status: 'failed',
        error: {
          code: 'desktop_backend_capability_missing',
          message,
        },
      }
    }

    logger.log(`Desktop local backend smoke passed: ${payload.runtimeStatus}`)
    return {
      status: 'ok',
      runtimeStatus: payload.runtimeStatus,
      capabilities: payload.capabilities || [],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Desktop local backend smoke failed: ${message}`)
    return {
      status: 'failed',
      error: {
        code: error instanceof Error && error.name === 'AbortError'
          ? 'desktop_backend_timeout'
          : 'desktop_backend_unreachable',
        message,
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

function missingRequiredCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return REQUIRED_CAPABILITIES
  return REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runDesktopBackendSmoke()
  if (result.status === 'failed') {
    process.exitCode = 1
  }
}
