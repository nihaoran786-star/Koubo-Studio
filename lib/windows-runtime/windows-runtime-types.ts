export type WindowsRuntimeStatus =
  | 'ready'
  | 'needs_install'
  | 'needs_restart'
  | 'failed'

export type WindowsRuntimeSuitability = 'unsuitable' | 'usable' | 'smooth'

export type WindowsRuntimeSource = 'windows_runtime_probe'

export type WindowsRuntimeErrorCode =
  | 'not_windows'
  | 'probe_failed'
  | 'wsl_unavailable'

export interface WindowsRuntimeError {
  code: WindowsRuntimeErrorCode
  message: string
}

export interface WindowsRuntimeThresholds {
  minimum: {
    ramGb: number
    vramGb: number
    diskGb: number
  }
  smooth: {
    ramGb: number
    vramGb: number
    diskGb: number
  }
}

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'unknown'

export interface WindowsRuntimeCheck<T> {
  status: CheckStatus
  value: T | null
  message: string
}

export interface WindowsRuntimeGpu {
  name: string
  memoryTotalGb: number
  driverVersion: string
}

export interface WindowsRuntimeReport {
  status: WindowsRuntimeStatus
  source: WindowsRuntimeSource
  error: WindowsRuntimeError | null
  suitability: WindowsRuntimeSuitability
  checkedAt: string
  thresholds: WindowsRuntimeThresholds
  checks: {
    windowsBuild: WindowsRuntimeCheck<number>
    wsl: WindowsRuntimeCheck<{
      installed: boolean
      version: string | null
      defaultVersion: number | null
      featureEnabled: boolean | null
      virtualMachinePlatformEnabled: boolean | null
    }>
    virtualization: WindowsRuntimeCheck<boolean>
    gpu: WindowsRuntimeCheck<WindowsRuntimeGpu>
    ram: WindowsRuntimeCheck<number>
    disk: WindowsRuntimeCheck<{ path: string; freeGb: number }>
    kouboRuntime: WindowsRuntimeCheck<boolean>
  }
}

export interface CommandResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  errorCode?: string
}

export interface WindowsSystemProbe {
  platform: NodeJS.Platform
  windowsBuild: number | null
  totalRamBytes: number | null
  virtualizationFirmwareEnabled: boolean | null
  wslFeatureEnabled: boolean | null
  virtualMachinePlatformEnabled: boolean | null
  runtimePath: string
  diskFreeBytes: number | null
  wslStatus: CommandResult
  wslVersion: CommandResult
  wslDistros: CommandResult
  nvidiaSmi: CommandResult
}

