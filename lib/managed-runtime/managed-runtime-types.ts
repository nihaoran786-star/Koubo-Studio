export const MANAGED_RUNTIME_NAME = 'KouboRuntime' as const
export const MANAGED_RUNTIME_API_URL = 'http://127.0.0.1:8383' as const
export const MANAGED_RUNTIME_HEALTH_URL = 'http://127.0.0.1:8383/health' as const
export const MANAGED_RUNTIME_MANIFEST_PATH = '/etc/koubo-runtime.json' as const

export type ManagedRuntimeStatus = 'absent' | 'stopped' | 'running' | 'ready' | 'failed'
export type ManagedRuntimeSource = 'managed_runtime_probe'
export type ManagedRuntimeHealth = 'not_checked' | 'healthy' | 'unhealthy'

export type ManagedRuntimeErrorCode =
  | 'probe_failed'
  | 'unsupported_wsl_version'
  | 'unknown_distro_state'
  | 'manifest_unavailable'
  | 'manifest_invalid'
  | 'health_unavailable'

export interface ManagedRuntimeError {
  code: ManagedRuntimeErrorCode
  message: string
}

export interface ManagedRuntimeManifest {
  schemaVersion: 1
  name: typeof MANAGED_RUNTIME_NAME
  version: string
  apiUrl: typeof MANAGED_RUNTIME_API_URL
}

export interface ManagedRuntimeDistro {
  name: string
  state: 'running' | 'stopped' | 'unknown'
  wslVersion: number
}

export interface ManagedRuntimeCommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export interface ManagedRuntimeProbe {
  list: ManagedRuntimeCommandResult
  distro: ManagedRuntimeDistro | null
  manifestCommand: ManagedRuntimeCommandResult | null
  manifest: ManagedRuntimeManifest | null
  health: {
    checked: boolean
    ok: boolean
    statusCode: number | null
  }
}

export interface ManagedRuntimeReport {
  status: ManagedRuntimeStatus
  source: ManagedRuntimeSource
  checkedAt: string
  runtime: {
    name: typeof MANAGED_RUNTIME_NAME
    installed: boolean
    distroState: 'absent' | 'stopped' | 'running' | 'unknown'
    wslVersion: number | null
    version: string | null
    apiUrl: typeof MANAGED_RUNTIME_API_URL
    health: ManagedRuntimeHealth
  }
  actions: {
    canImport: boolean
    canStart: boolean
    canStop: boolean
    canUninstall: boolean
  }
  error: ManagedRuntimeError | null
}
