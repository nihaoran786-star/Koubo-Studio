import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PROJECT_ID = 'desktop-release-smoke'
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3100'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_INTERVAL_MS = 1000
const REQUIRED_CAPABILITIES = [
  'script_agent',
  'audio_agent',
  'digital_human',
  'post_production',
  'publish_agent',
]

export function readDesktopReleaseSmokeConfig(env = process.env, root = process.cwd()) {
  const timeoutMs = Number(env.DESKTOP_RELEASE_SMOKE_TIMEOUT_MS)
  const intervalMs = Number(env.DESKTOP_RELEASE_SMOKE_INTERVAL_MS)
  const exePath = (env.DESKTOP_RELEASE_EXE_PATH || path.join(root, 'src-tauri', '.target', 'release', 'koubo-agent.exe')).trim()

  return {
    enabled: env.RUN_DESKTOP_RELEASE_SMOKE === '1',
    exePath,
    nodePath: (env.DESKTOP_BACKEND_NODE_PATH || '').trim(),
    backendUrl: (env.DESKTOP_RELEASE_BACKEND_URL || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, ''),
    backendPort: readBackendPort(env.DESKTOP_RELEASE_BACKEND_URL || DEFAULT_BACKEND_URL),
    projectId: (env.DESKTOP_RELEASE_SMOKE_PROJECT_ID || DEFAULT_PROJECT_ID).trim() || DEFAULT_PROJECT_ID,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS,
  }
}

export async function runDesktopReleaseSmoke({
  env = process.env,
  root = process.cwd(),
  fetcher = fetch,
  launcher = launchDesktopRelease,
  cleanup = cleanupProcessTree,
  getExecutableVersion = defaultGetExecutableVersion,
  logger = console,
} = {}) {
  const config = readDesktopReleaseSmokeConfig(env, root)

  if (!config.enabled) {
    logger.log('Desktop release smoke skipped. Set RUN_DESKTOP_RELEASE_SMOKE=1 to enable.')
    return {
      status: 'skipped',
      reason: 'disabled',
    }
  }

  if (!existsSync(config.exePath)) {
    logger.error(`Desktop release smoke failed: release exe missing at ${config.exePath}`)
    return {
      status: 'failed',
      error: {
        code: 'desktop_release_exe_missing',
        message: `Release exe missing at ${config.exePath}`,
      },
    }
  }

  if (config.nodePath) {
    if (!existsSync(config.nodePath)) {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_backend_node_missing',
        message: `DESKTOP_BACKEND_NODE_PATH does not exist: ${config.nodePath}`,
      })
    }
    const nodeVersion = getExecutableVersion(config.nodePath)
    if (!nodeVersion) {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_backend_node_unavailable',
        message: 'DESKTOP_BACKEND_NODE_PATH could not run node --version.',
      })
    }
    if (!isNodeVersionAtLeast(nodeVersion, 22, 19, 0)) {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_backend_node_too_old',
        message: `DESKTOP_BACKEND_NODE_PATH is ${nodeVersion}; Node 22.19.0+ is required.`,
      })
    }
  }

  const processHandle = launcher(config.exePath, { backendPort: config.backendPort })
  try {
    const payload = await waitForDesktopRuntime({
      config,
      fetcher,
    })
    const nodeRequirement = findNodeRequirement(payload)
    if (payload.status !== 'available' || payload.runtimeStatus !== 'local_backend_ready') {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_release_backend_not_ready',
        message: `Expected local_backend_ready, got ${payload.runtimeStatus || payload.status || 'unknown'}`,
      })
    }

    const missingCapabilities = missingRequiredCapabilities(payload.capabilities)
    if (missingCapabilities.length > 0) {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_release_capability_missing',
        message: `Desktop release backend is missing capabilities: ${missingCapabilities.join(', ')}`,
      })
    }

    if (!nodeRequirement || nodeRequirement.status !== 'ready') {
      return releaseSmokeFailure({
        logger,
        code: 'desktop_release_node_not_ready',
        message: 'script_agent node_runtime requirement is not ready.',
      })
    }

    logger.log(`Desktop release smoke passed: ${payload.runtimeStatus}, Node ${nodeRequirement.actualVersion}`)
    return {
      status: 'ok',
      runtimeStatus: payload.runtimeStatus,
      nodeVersion: nodeRequirement.actualVersion,
      requirements: payload.requirements,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return releaseSmokeFailure({
      logger,
      code: 'desktop_release_backend_timeout',
      message,
    })
  } finally {
    await cleanup(processHandle)
  }
}

export function launchDesktopRelease(exePath, options = {}) {
  const backendPort = options.backendPort ? String(options.backendPort) : ''
  const child = spawn(exePath, [], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...(backendPort
        ? {
            KOUBO_BACKEND_PORT: backendPort,
            PORT: backendPort,
          }
        : {}),
    },
  })

  return {
    pid: child.pid,
    child,
  }
}

export async function cleanupProcessTree(processHandle) {
  if (!processHandle?.pid) return

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'])
    return
  }

  processHandle.child?.kill('SIGTERM')
}

async function waitForDesktopRuntime({ config, fetcher }) {
  const start = Date.now()
  let lastError
  const endpoint = `${config.backendUrl}/api/projects/${encodeURIComponent(config.projectId)}/desktop-runtime`

  while (Date.now() - start < config.timeoutMs) {
    try {
      const response = await fetcher(endpoint, { method: 'GET' })
      const payload = await response.json()
      if (response.ok && payload?.status) {
        return payload
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(config.intervalMs)
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'timeout'))
}

function findNodeRequirement(payload) {
  if (!Array.isArray(payload?.requirements)) return undefined
  return payload.requirements.find(
    (requirement) =>
      requirement?.id === 'node_runtime' &&
      requirement?.capability === 'script_agent',
  )
}

function missingRequiredCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return REQUIRED_CAPABILITIES
  return REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability))
}

function releaseSmokeFailure({ logger, code, message }) {
  logger.error(`Desktop release smoke failed (${code}): ${message}`)
  return {
    status: 'failed',
    error: {
      code,
      message,
    },
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => resolve())
    child.on('exit', () => resolve())
  })
}

function readBackendPort(rawUrl) {
  try {
    const url = new URL((rawUrl || DEFAULT_BACKEND_URL).trim())
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return '3100'
  }
}

function defaultGetExecutableVersion(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return undefined
  return String(result.stdout || result.stderr).trim()
}

function isNodeVersionAtLeast(version, major, minor, patch) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  const [, actualMajor, actualMinor, actualPatch] = match.map(Number)
  if (actualMajor !== major) return actualMajor > major
  if (actualMinor !== minor) return actualMinor > minor
  return actualPatch >= patch
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runDesktopReleaseSmoke()
  if (result.status === 'failed') {
    process.exitCode = 1
  }
}
