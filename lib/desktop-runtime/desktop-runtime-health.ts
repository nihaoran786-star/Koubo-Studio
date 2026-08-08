import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'

export type DesktopRuntimeCapability =
  | 'script_agent'
  | 'audio_agent'
  | 'digital_human'
  | 'post_production'
  | 'publish_agent'

export type DesktopRuntimeStatus =
  | 'dev_server'
  | 'static_only'
  | 'local_backend_ready'
  | 'local_backend_missing'
  | 'local_backend_failed'

export type DesktopRuntimeRequirement =
  | {
      id: 'node_runtime'
      capability: 'script_agent'
      status: 'ready'
      requiredVersion: string
      actualVersion: string
      error?: never
    }
  | {
      id: 'node_runtime'
      capability: 'script_agent'
      status: 'blocked'
      requiredVersion: string
      actualVersion: string
      error: {
        code: 'unsupported_node_version'
        message: string
      }
    }

export type DesktopRuntimeHealthResult =
  | {
      status: 'available'
      source: 'desktop_runtime'
      runtimeStatus: 'dev_server' | 'local_backend_ready'
      capabilities: DesktopRuntimeCapability[]
      requirements: DesktopRuntimeRequirement[]
      backendUrl?: string
      version?: string
      error?: never
    }
  | {
      status: 'unavailable'
      source: 'desktop_runtime'
      runtimeStatus: 'static_only' | 'local_backend_missing' | 'local_backend_failed'
      capabilities: DesktopRuntimeCapability[]
      requirements: DesktopRuntimeRequirement[]
      backendUrl?: string
      version?: string
      error: {
        code: 'desktop_backend_missing' | 'desktop_backend_unreachable'
        message: string
      }
    }

export interface DesktopRuntimeConfig {
  desktopExport: boolean
  backendUrl?: string
  backendMode?: 'sidecar'
  timeoutMs: number
}

type Fetcher = typeof fetch
type RuntimeEnv = Record<string, string | undefined>

const DEFAULT_TIMEOUT_MS = 3000
const MIN_BACKEND_NODE_VERSION = '22.19.0'
const ALL_CAPABILITIES: DesktopRuntimeCapability[] = [
  'script_agent',
  'audio_agent',
  'digital_human',
  'post_production',
  'publish_agent',
]

export function desktopRuntimeEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/desktop-runtime')
}

export function readDesktopRuntimeConfig(env: RuntimeEnv = process.env): DesktopRuntimeConfig {
  const backendUrl = env.DESKTOP_LOCAL_BACKEND_URL?.trim().replace(/\/+$/, '')
  const timeoutMs = Number(env.DESKTOP_LOCAL_BACKEND_TIMEOUT_MS)

  return {
    desktopExport: env.NEXT_DESKTOP_EXPORT === '1',
    backendUrl: backendUrl || undefined,
    backendMode: env.DESKTOP_BACKEND_MODE === 'sidecar' ? 'sidecar' : undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

export async function detectDesktopRuntimeHealth(options: {
  projectId: string
  env?: RuntimeEnv
  fetcher?: Fetcher
  nodeVersion?: string
}): Promise<DesktopRuntimeHealthResult> {
  const config = readDesktopRuntimeConfig(options.env)
  const requirements = buildRuntimeRequirements(options.nodeVersion ?? process.versions.node)

  if (config.backendMode === 'sidecar') {
    return {
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_ready',
      backendUrl: config.backendUrl,
      capabilities: ALL_CAPABILITIES,
      requirements,
    }
  }

  if (!config.desktopExport && !config.backendUrl) {
    return {
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'dev_server',
      capabilities: ALL_CAPABILITIES,
      requirements,
    }
  }

  if (!config.backendUrl) {
    return {
      status: 'unavailable',
      source: 'desktop_runtime',
      runtimeStatus: 'static_only',
      capabilities: [],
      requirements: [],
      error: {
        code: 'desktop_backend_missing',
        message: '桌面端生产包当前是静态前端，缺少可承载 API route 的本地后端。',
      },
    }
  }

  return checkLocalBackend({
    projectId: options.projectId,
    backendUrl: config.backendUrl,
    timeoutMs: config.timeoutMs,
    fetcher: options.fetcher ?? fetch,
  })
}

export function buildRuntimeRequirements(nodeVersion: string): DesktopRuntimeRequirement[] {
  if (isSupportedNodeVersion(nodeVersion)) {
    return [
      {
        id: 'node_runtime',
        capability: 'script_agent',
        status: 'ready',
        requiredVersion: MIN_BACKEND_NODE_VERSION,
        actualVersion: nodeVersion,
      },
    ]
  }

  return [
    {
      id: 'node_runtime',
      capability: 'script_agent',
      status: 'blocked',
      requiredVersion: MIN_BACKEND_NODE_VERSION,
      actualVersion: nodeVersion,
      error: {
        code: 'unsupported_node_version',
        message: `本地后端需要 Node >= ${MIN_BACKEND_NODE_VERSION}，当前是 ${nodeVersion}`,
      },
    },
  ]
}

async function checkLocalBackend(options: {
  projectId: string
  backendUrl: string
  timeoutMs: number
  fetcher: Fetcher
}): Promise<DesktopRuntimeHealthResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)

  try {
    const response = await options.fetcher(`${options.backendUrl}${buildProjectApiEndpoint(options.projectId, '/desktop-runtime', {})}`, {
      method: 'GET',
      signal: controller.signal,
    })
    if (!response.ok) {
      return localBackendFailed(options.backendUrl)
    }

    const payload = (await response.json()) as {
      status?: 'available' | 'unavailable' | 'ok'
      version?: string
      capabilities?: unknown
      requirements?: unknown
    }
    if (payload.status !== 'available' && payload.status !== 'ok') {
      return localBackendFailed(options.backendUrl)
    }

    return {
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_ready',
      backendUrl: options.backendUrl,
      version: payload.version,
      capabilities: normalizeCapabilities(payload.capabilities),
      requirements: normalizeRequirements(payload.requirements),
    }
  } catch {
    return localBackendFailed(options.backendUrl)
  } finally {
    clearTimeout(timeout)
  }
}

function localBackendFailed(backendUrl: string): DesktopRuntimeHealthResult {
  return {
    status: 'unavailable',
    source: 'desktop_runtime',
    runtimeStatus: 'local_backend_failed',
    backendUrl,
    capabilities: [],
    requirements: [],
    error: {
      code: 'desktop_backend_unreachable',
      message: '已配置桌面端本地后端，但健康检查无法连通。',
    },
  }
}

function normalizeCapabilities(capabilities: unknown): DesktopRuntimeCapability[] {
  if (!Array.isArray(capabilities)) return ALL_CAPABILITIES
  return capabilities.filter((item): item is DesktopRuntimeCapability =>
    ALL_CAPABILITIES.includes(item as DesktopRuntimeCapability),
  )
}

function normalizeRequirements(requirements: unknown): DesktopRuntimeRequirement[] {
  if (!Array.isArray(requirements)) return []

  return requirements.filter((item): item is DesktopRuntimeRequirement => {
    if (typeof item !== 'object' || item === null) return false
    const requirement = item as Partial<DesktopRuntimeRequirement>
    return (
      requirement.id === 'node_runtime' &&
      requirement.capability === 'script_agent' &&
      (requirement.status === 'ready' || requirement.status === 'blocked') &&
      typeof requirement.requiredVersion === 'string' &&
      typeof requirement.actualVersion === 'string'
    )
  })
}

function isSupportedNodeVersion(version: string) {
  const current = parseVersion(version)
  const minimum = parseVersion(MIN_BACKEND_NODE_VERSION)

  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true
    if (current[index] < minimum[index]) return false
  }

  return true
}

function parseVersion(version: string) {
  return version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
}
