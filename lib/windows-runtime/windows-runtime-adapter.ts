import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CommandResult, WindowsSystemProbe } from './windows-runtime-types'

const SYSTEM_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$wsl = Get-CimInstance Win32_OptionalFeature -Filter "Name='Microsoft-Windows-Subsystem-Linux'"
$vmp = Get-CimInstance Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform'"
[pscustomobject]@{
  windowsBuild = [int]$os.BuildNumber
  totalRamBytes = [int64]$os.TotalVisibleMemorySize * 1KB
  virtualizationFirmwareEnabled = if ($null -eq $cpu.VirtualizationFirmwareEnabled) { $null } else { [bool]$cpu.VirtualizationFirmwareEnabled }
  wslFeatureEnabled = if ($null -eq $wsl) { $false } else { [int]$wsl.InstallState -eq 1 }
  virtualMachinePlatformEnabled = if ($null -eq $vmp) { $false } else { [int]$vmp.InstallState -eq 1 }
} | ConvertTo-Json -Compress
`.trim()

const NVIDIA_QUERY_ARGS = [
  '--query-gpu=name,memory.total,driver_version',
  '--format=csv,noheader,nounits',
] as const

export type FixedCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<CommandResult>

export async function probeWindowsRuntime({
  runner = runFixedCommand,
  platform = process.platform,
  runtimePath = defaultRuntimePath(),
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
}: {
  runner?: FixedCommandRunner
  platform?: NodeJS.Platform
  runtimePath?: string
  systemRoot?: string
} = {}): Promise<WindowsSystemProbe> {
  if (platform !== 'win32') {
    return emptyProbe(platform, runtimePath)
  }

  const system32 = path.win32.join(systemRoot, 'System32')
  const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const wsl = path.win32.join(system32, 'wsl.exe')
  const nvidiaSmiExecutable = path.win32.join(system32, 'nvidia-smi.exe')
  const [system, wslStatus, wslVersion, wslDistros, nvidiaSmi, diskFreeBytes] = await Promise.all([
    runner(powershell, ['-NoProfile', '-NonInteractive', '-Command', SYSTEM_PROBE_SCRIPT]),
    runner(wsl, ['--status']),
    runner(wsl, ['--version']),
    runner(wsl, ['--list', '--quiet']),
    runner(nvidiaSmiExecutable, NVIDIA_QUERY_ARGS),
    readDiskFreeBytes(runtimePath),
  ])

  const systemData = parseSystemProbe(system)
  return {
    platform,
    windowsBuild: systemData.windowsBuild,
    totalRamBytes: systemData.totalRamBytes,
    virtualizationFirmwareEnabled: systemData.virtualizationFirmwareEnabled,
    wslFeatureEnabled: systemData.wslFeatureEnabled,
    virtualMachinePlatformEnabled: systemData.virtualMachinePlatformEnabled,
    runtimePath,
    diskFreeBytes,
    wslStatus,
    wslVersion,
    wslDistros,
    nvidiaSmi,
  }
}

export async function runFixedCommand(
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(executable, [...args], {
      encoding: 'buffer',
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const value = error as (NodeJS.ErrnoException & { code?: string | number }) | null
      resolve({
        ok: !error,
        exitCode: error ? (typeof value?.code === 'number' ? value.code : null) : 0,
        stdout: decodeWindowsOutput(stdout),
        stderr: decodeWindowsOutput(stderr) || error?.message || '',
        errorCode: typeof value?.code === 'string' ? value.code : undefined,
      })
    })
  })
}

export function decodeWindowsOutput(value: Buffer | string) {
  if (typeof value === 'string') return value
  if (value.length === 0) return ''
  const hasUtf16LeBom = value[0] === 0xff && value[1] === 0xfe
  const sampleLength = Math.min(value.length, 200)
  let oddNuls = 0
  let oddBytes = 0
  for (let index = 1; index < sampleLength; index += 2) {
    oddBytes += 1
    if (value[index] === 0) oddNuls += 1
  }
  const looksUtf16Le = hasUtf16LeBom || (oddBytes > 0 && oddNuls / oddBytes > 0.3)
  return value.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
}

function parseSystemProbe(result: CommandResult): {
  windowsBuild: number | null
  totalRamBytes: number | null
  virtualizationFirmwareEnabled: boolean | null
  wslFeatureEnabled: boolean | null
  virtualMachinePlatformEnabled: boolean | null
} {
  const fallback = {
    windowsBuild: null,
    totalRamBytes: null,
    virtualizationFirmwareEnabled: null,
    wslFeatureEnabled: null,
    virtualMachinePlatformEnabled: null,
  }
  if (!result.ok) return fallback
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    return {
      windowsBuild: numberOrNull(parsed.windowsBuild),
      totalRamBytes: numberOrNull(parsed.totalRamBytes),
      virtualizationFirmwareEnabled: booleanOrNull(parsed.virtualizationFirmwareEnabled),
      wslFeatureEnabled: booleanOrNull(parsed.wslFeatureEnabled),
      virtualMachinePlatformEnabled: booleanOrNull(parsed.virtualMachinePlatformEnabled),
    }
  } catch {
    return fallback
  }
}

async function readDiskFreeBytes(runtimePath: string): Promise<number | null> {
  let candidate = path.resolve(runtimePath)
  while (true) {
    try {
      const stats = await fs.statfs(candidate)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return null
      candidate = parent
    }
  }
}

function defaultRuntimePath() {
  return process.env.KOUBO_RUNTIME_ROOT?.trim()
    || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'KouboAgent', 'runtime')
}

function emptyProbe(platform: NodeJS.Platform, runtimePath: string): WindowsSystemProbe {
  const unavailable = (): CommandResult => ({
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '仅支持 Windows。',
    errorCode: 'ENOTSUP',
  })
  return {
    platform,
    windowsBuild: null,
    totalRamBytes: null,
    virtualizationFirmwareEnabled: null,
    wslFeatureEnabled: null,
    virtualMachinePlatformEnabled: null,
    runtimePath,
    diskFreeBytes: null,
    wslStatus: unavailable(),
    wslVersion: unavailable(),
    wslDistros: unavailable(),
    nvidiaSmi: unavailable(),
  }
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanOrNull(value: unknown) {
  return typeof value === 'boolean' ? value : null
}
