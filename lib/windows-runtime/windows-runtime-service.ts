import { probeWindowsRuntime } from './windows-runtime-adapter'
import type {
  CheckStatus,
  CommandResult,
  WindowsRuntimeCheck,
  WindowsRuntimeGpu,
  WindowsRuntimeReport,
  WindowsRuntimeStatus,
  WindowsRuntimeSuitability,
  WindowsSystemProbe,
} from './windows-runtime-types'

const GIB = 1024 ** 3
const MINIMUM_WINDOWS_BUILD = 19041

export const WINDOWS_RUNTIME_THRESHOLDS = {
  minimum: { ramGb: 16, vramGb: 8, diskGb: 40 },
  smooth: { ramGb: 32, vramGb: 12, diskGb: 60 },
} as const

export async function inspectWindowsRuntime({
  probe = probeWindowsRuntime,
  now = () => new Date(),
}: {
  probe?: () => Promise<WindowsSystemProbe>
  now?: () => Date
} = {}): Promise<WindowsRuntimeReport> {
  let raw: WindowsSystemProbe
  try {
    raw = await probe()
  } catch {
    return failedReport('probe_failed', '无法读取 Windows 环境信息。', now())
  }

  if (raw.platform !== 'win32') {
    return failedReport('not_windows', '数字人本地环境检查仅支持 Windows。', now())
  }
  if (systemProbeUnavailable(raw)) {
    return failedReport('probe_failed', '无法读取 Windows 系统与硬件信息，请检查 Windows 管理服务后重试。', now())
  }

  const gpu = parseBestGpu(raw.nvidiaSmi)
  const ramGb = bytesToGb(raw.totalRamBytes)
  const diskGb = bytesToGb(raw.diskFreeBytes)
  const restartRequired = isRestartRequired(raw)
  const wslFeatureKnown = raw.wslFeatureEnabled !== null
  const wslInstalled = raw.wslFeatureEnabled === true && !isCommandMissing(raw.wslVersion)
  const version = parseWslVersion(raw.wslVersion.stdout)
  const defaultVersion = parseDefaultWslVersion(raw.wslStatus.stdout)
  const wsl2Operational = raw.virtualMachinePlatformEnabled === true
    && (raw.wslStatus.ok || raw.wslVersion.ok)
  const status: WindowsRuntimeStatus = !wslFeatureKnown
    ? 'failed'
    : !wslInstalled
    ? 'needs_install'
    : restartRequired
      ? 'needs_restart'
      : wsl2Operational
        ? 'ready'
        : 'failed'
  const distroInstalled = raw.wslDistros.ok
    ? parseDistros(raw.wslDistros).some(
        (name) => name.toLocaleLowerCase() === 'kouboruntime'.toLocaleLowerCase(),
      )
    : null

  const checks: WindowsRuntimeReport['checks'] = {
    windowsBuild: windowsBuildCheck(raw.windowsBuild),
    wsl: {
      status: wslFeatureKnown ? wslCheckStatus(status) : 'unknown',
      value: {
        installed: wslInstalled,
        version,
        defaultVersion,
        featureEnabled: raw.wslFeatureEnabled,
        virtualMachinePlatformEnabled: raw.virtualMachinePlatformEnabled,
      },
      message: wslMessage(status, {
        installed: wslInstalled,
        version,
        featureEnabled: raw.wslFeatureEnabled,
        defaultVersion,
        virtualMachinePlatformEnabled: raw.virtualMachinePlatformEnabled,
      }),
    },
    virtualization: wsl2Operational
      ? {
          status: 'pass',
          value: true,
          message: raw.virtualizationFirmwareEnabled === false
            ? 'WSL 已实际运行；固件虚拟化字段不准确，已按运行结果确认可用。'
            : '硬件虚拟化已启用。',
        }
      : booleanCheck(
          raw.virtualizationFirmwareEnabled,
          '硬件虚拟化已启用。',
          '硬件虚拟化未启用，请在 BIOS/UEFI 中开启。',
        ),
    gpu: gpu
      ? gpuCheck(gpu)
      : { status: 'fail', value: null, message: '未检测到可用的 NVIDIA GPU 或驱动。' },
    ram: thresholdCheck(ramGb, WINDOWS_RUNTIME_THRESHOLDS.minimum.ramGb, WINDOWS_RUNTIME_THRESHOLDS.smooth.ramGb, '内存'),
    disk: thresholdCheck(
      diskGb === null ? null : { path: raw.runtimePath, freeGb: diskGb },
      WINDOWS_RUNTIME_THRESHOLDS.minimum.diskGb,
      WINDOWS_RUNTIME_THRESHOLDS.smooth.diskGb,
      '运行环境磁盘空间',
      (value) => value.freeGb,
    ),
    kouboRuntime: {
      status: distroInstalled === null ? 'unknown' : distroInstalled ? 'pass' : 'warning',
      value: distroInstalled,
      message: distroInstalled === null
        ? '无法读取 WSL 发行版列表，暂时不能确认 KouboRuntime 是否安装。'
        : distroInstalled
          ? 'KouboRuntime 已安装；完整可用性由下方运行环境检查继续验证。'
          : 'KouboRuntime 尚未安装。',
    },
  }
  const suitability = assessSuitability(checks)
  return {
    status,
    source: 'windows_runtime_probe',
    error: status === 'failed'
      ? { code: 'wsl_unavailable', message: 'WSL 已启用，但当前无法正常运行。' }
      : null,
    suitability,
    checkedAt: now().toISOString(),
    thresholds: WINDOWS_RUNTIME_THRESHOLDS,
    checks,
  }
}

function windowsBuildCheck(value: number | null): WindowsRuntimeCheck<number> {
  if (value === null) return { status: 'unknown', value, message: '无法读取 Windows build。' }
  return value < MINIMUM_WINDOWS_BUILD
    ? {
        status: 'fail',
        value,
        message: `Windows Build ${value} 过旧，至少需要 Build ${MINIMUM_WINDOWS_BUILD}。`,
      }
    : {
        status: 'pass',
        value,
        message: `Windows Build ${value} 满足运行要求。`,
      }
}

function assessSuitability(checks: WindowsRuntimeReport['checks']): WindowsRuntimeSuitability {
  // WSL is an installable prerequisite, not a hardware capability. Keeping it
  // out of this grade lets a capable machine remain "smooth" before WSL is installed.
  const required = [checks.windowsBuild, checks.virtualization, checks.gpu, checks.ram, checks.disk]
  if (required.some((check) => check.status === 'fail' || check.status === 'unknown')) return 'unsuitable'
  if ([checks.gpu, checks.ram, checks.disk].every((check) => check.status === 'pass')) return 'smooth'
  return 'usable'
}

function thresholdCheck<T>(
  value: T | null,
  minimum: number,
  smooth: number,
  label: string,
  select: (value: T) => number = (item) => item as number,
): WindowsRuntimeCheck<T> {
  if (value === null) return { status: 'unknown', value, message: `无法读取${label}。` }
  const amount = select(value)
  const status: CheckStatus = amount < minimum ? 'fail' : amount < smooth ? 'warning' : 'pass'
  return {
    status,
    value,
    message: amount < minimum
      ? `${label}为 ${amount} GB，不足最低要求 ${minimum} GB。`
      : amount < smooth
        ? `${label}为 ${amount} GB，可以使用；达到 ${smooth} GB 会更流畅。`
        : `${label}为 ${amount} GB，满足流畅运行要求。`,
  }
}

function gpuCheck(gpu: WindowsRuntimeGpu): WindowsRuntimeCheck<WindowsRuntimeGpu> {
  const check = thresholdCheck(
    gpu,
    WINDOWS_RUNTIME_THRESHOLDS.minimum.vramGb,
    WINDOWS_RUNTIME_THRESHOLDS.smooth.vramGb,
    '显存',
    (value) => value.memoryTotalGb,
  )
  return {
    ...check,
    message: `${gpu.name}，${check.message} 驱动 ${gpu.driverVersion}。`,
  }
}

function booleanCheck(value: boolean | null, pass: string, fail: string): WindowsRuntimeCheck<boolean> {
  if (value === null) return { status: 'unknown', value, message: '无法读取硬件虚拟化状态。' }
  return { status: value ? 'pass' : 'fail', value, message: value ? pass : fail }
}

function wslCheckStatus(status: WindowsRuntimeStatus): CheckStatus {
  if (status === 'ready') return 'pass'
  if (status === 'needs_restart') return 'warning'
  return 'fail'
}

function wslMessage(
  status: WindowsRuntimeStatus,
  state: {
    installed: boolean
    version: string | null
    featureEnabled: boolean | null
    defaultVersion: number | null
    virtualMachinePlatformEnabled: boolean | null
  },
) {
  if (state.featureEnabled === null) return '无法读取 Windows WSL 功能状态，请重新检查。'
  if (status === 'needs_install') return 'WSL 尚未安装或必要功能未启用。'
  if (status === 'needs_restart') return 'WSL 已安装，重启 Windows 后即可继续。'
  if (status === 'ready') {
    const version = state.version ? `，组件版本 ${state.version}` : ''
    const defaultNote = state.defaultVersion === 1
      ? '；系统默认发行版版本为 1，但本软件会把 KouboRuntime 明确安装为 WSL 2'
      : ''
    return `WSL 2 平台已就绪${version}${defaultNote}。`
  }
  if (!state.installed && state.featureEnabled === true) {
    return 'WSL 功能已启用，但系统 WSL 程序不可用，需要修复 Windows WSL 组件。'
  }
  if (state.installed && state.virtualMachinePlatformEnabled !== true) {
    return '已检测到 WSL，但 WSL 2 所需的虚拟机平台未启用。'
  }
  if (state.installed && state.defaultVersion !== 2) {
    return '已检测到 WSL，但默认版本不是 WSL 2。'
  }
  return 'WSL 2 已启用，但状态检查失败。'
}

function parseBestGpu(result: CommandResult): WindowsRuntimeGpu | null {
  if (!result.ok) return null
  const devices = result.stdout.split(/\r?\n/).flatMap((line) => {
    const parts = line.split(',').map((part) => part.trim())
    const memoryMb = Number(parts[1])
    if (parts.length < 3 || !Number.isFinite(memoryMb)) return []
    return [{ name: parts[0], memoryTotalGb: round(memoryMb / 1024), driverVersion: parts[2] }]
  })
  return devices.sort((a, b) => b.memoryTotalGb - a.memoryTotalGb)[0] ?? null
}

function parseDistros(result: CommandResult) {
  if (!result.ok) return []
  return result.stdout.replace(/\u0000/g, '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

function parseWslVersion(output: string) {
  return output.replace(/\u0000/g, '').match(/WSL\s*(?:version|版本)?\s*[:：]\s*([\d.]+)/i)?.[1] ?? null
}

function parseDefaultWslVersion(output: string) {
  const match = output.replace(/\u0000/g, '').match(/(?:Default Version|默认版本)\s*[:：]\s*([12])/i)
  return match ? Number(match[1]) : null
}

function isRestartRequired(raw: WindowsSystemProbe) {
  const output = `${raw.wslStatus.stdout}\n${raw.wslStatus.stderr}\n${raw.wslVersion.stdout}\n${raw.wslVersion.stderr}`
  return /restart|reboot|重新启动|重启|0x80070bc2/i.test(output)
}

function isCommandMissing(result: CommandResult) {
  return result.errorCode === 'ENOENT'
}

function systemProbeUnavailable(raw: WindowsSystemProbe) {
  return raw.windowsBuild === null
    && raw.totalRamBytes === null
    && raw.virtualizationFirmwareEnabled === null
    && raw.wslFeatureEnabled === null
    && raw.virtualMachinePlatformEnabled === null
}

function bytesToGb(value: number | null) {
  return value === null ? null : round(value / GIB)
}

function round(value: number) {
  return Math.round(value * 10) / 10
}

function failedReport(
  code: 'not_windows' | 'probe_failed',
  message: string,
  now: Date,
): WindowsRuntimeReport {
  const unknown = <T>(text: string): WindowsRuntimeCheck<T> => ({ status: 'unknown', value: null, message: text })
  return {
    status: 'failed',
    source: 'windows_runtime_probe',
    error: { code, message },
    suitability: 'unsuitable',
    checkedAt: now.toISOString(),
    thresholds: WINDOWS_RUNTIME_THRESHOLDS,
    checks: {
      windowsBuild: unknown('未执行 Windows build 检查。'),
      wsl: unknown('未执行 WSL 检查。'),
      virtualization: unknown('未执行虚拟化检查。'),
      gpu: unknown('未执行 GPU 检查。'),
      ram: unknown('未执行内存检查。'),
      disk: unknown('未执行磁盘检查。'),
      kouboRuntime: unknown('未执行 KouboRuntime 检查。'),
    },
  }
}
