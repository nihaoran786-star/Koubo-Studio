import { inspectWindowsRuntime } from './windows-runtime-service'
import type { WindowsRuntimeCheck, WindowsRuntimeReport } from './windows-runtime-types'

export type WindowsRuntimeDto =
  | {
      status: 'ok'
      source: 'windows_runtime'
      assessment: {
        grade: 'unsuitable' | 'usable' | 'smooth'
        label: string
        summary: string
      }
      checks: Array<{
        id: string
        title: string
        status: 'ready' | 'warning' | 'missing' | 'unknown'
        detail: string
        action?: string
      }>
      install: {
        wslInstalled: boolean
        restartRequired: boolean
        kouboRuntimeInstalled: boolean
        canInstallWsl: boolean
      }
    }
  | {
      status: 'error'
      source: 'windows_runtime'
      error: {
        code: string
        message: string
      }
    }

export async function handleWindowsRuntimeGet({
  inspect = inspectWindowsRuntime,
}: {
  inspect?: () => Promise<WindowsRuntimeReport>
} = {}) {
  const report = await inspect()
  const dto = mapWindowsRuntimeReport(report)
  return Response.json(dto, {
    status: dto.status === 'error' ? 500 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function mapWindowsRuntimeReport(report: WindowsRuntimeReport): WindowsRuntimeDto {
  if (report.error?.code === 'probe_failed' || report.error?.code === 'not_windows') {
    return {
      status: 'error',
      source: 'windows_runtime',
      error: report.error,
    }
  }

  const wslInstalled = report.checks.wsl.value?.installed ?? false
  const kouboRuntimeInstalled = report.checks.kouboRuntime.value ?? false
  return {
    status: 'ok',
    source: 'windows_runtime',
    assessment: {
      grade: report.suitability,
      label: assessmentLabel(report),
      summary: assessmentSummary(report),
    },
    checks: [
      mapCheck('windows_build', 'Windows 版本', report.checks.windowsBuild,
        '升级到 Windows 10 2004（Build 19041）或更新版本。'),
      mapCheck('wsl', 'WSL 2', report.checks.wsl,
        wslRecoveryAction(report)),
      mapCheck('virtualization', '硬件虚拟化', report.checks.virtualization,
        '在 BIOS/UEFI 中开启 Intel VT-x 或 AMD-V。'),
      mapCheck('gpu', 'NVIDIA 显卡与显存', report.checks.gpu,
        '安装或更新 NVIDIA 驱动；本地数字人至少需要 8 GB 显存。'),
      mapCheck('ram', '系统内存', report.checks.ram,
        '本地数字人至少需要 16 GB 内存。'),
      mapCheck('disk', '运行环境磁盘空间', report.checks.disk,
        '清理运行环境所在磁盘，至少保留 40 GB。'),
      mapCheck('koubo_runtime', '数字人运行环境', report.checks.kouboRuntime,
        '在下方导入并安装 KouboRuntime 运行包。'),
    ],
    install: {
      wslInstalled,
      restartRequired: report.status === 'needs_restart',
      kouboRuntimeInstalled,
      canInstallWsl: report.checks.wsl.value?.featureEnabled === false
        && report.checks.windowsBuild.status === 'pass',
    },
  }
}

function assessmentLabel(report: WindowsRuntimeReport) {
  if (report.status === 'needs_install') return '需要安装 WSL'
  if (report.status === 'needs_restart') return '需要重启'
  if (report.status === 'failed') return '环境待修复'
  if (report.suitability === 'unsuitable') return '配置不足'
  if (report.checks.kouboRuntime.value !== true) return '硬件已通过'
  return '环境已安装'
}

function mapCheck<T>(
  id: string,
  title: string,
  check: WindowsRuntimeCheck<T>,
  action: string,
) {
  const status = check.status === 'pass'
    ? 'ready' as const
    : check.status === 'warning'
      ? 'warning' as const
      : check.status === 'unknown'
        ? 'unknown' as const
        : 'missing' as const
  return {
    id,
    title,
    status,
    detail: check.message,
    ...(status === 'ready' ? {} : { action }),
  }
}

function assessmentSummary(report: WindowsRuntimeReport) {
  if (report.status === 'needs_install') return '当前电脑需要先安装 WSL 2，安装后才能部署本地数字人环境。'
  if (report.status === 'needs_restart') return 'WSL 2 已安装，重启 Windows 后即可继续部署本地数字人环境。'
  if (report.status === 'failed') return 'WSL 2 当前无法正常运行，请按检查项修复后重试。'
  if (report.suitability === 'smooth') return '硬件满足流畅运行本地数字人的建议配置。'
  if (report.suitability === 'usable') return '硬件达到本地数字人的最低配置，可以使用但生成速度可能较慢。'
  return '当前硬件未达到本地数字人的最低配置。'
}

function wslRecoveryAction(report: WindowsRuntimeReport) {
  if (report.status === 'needs_restart') return '重启 Windows 后重新检查。'
  const wsl = report.checks.wsl.value
  if (wsl?.featureEnabled === null || !wsl) return '重新检查；仍无法读取时请先修复 Windows 系统信息服务。'
  if (!wsl?.installed && wsl.featureEnabled === true) return '修复或更新 Windows WSL 系统组件后重新检查。'
  if (!wsl?.installed) return '点击安装 WSL。'
  if (wsl.virtualMachinePlatformEnabled !== true) {
    return '启用 Virtual Machine Platform，重启后重新检查。'
  }
  if (wsl.defaultVersion !== 2) return '运行 wsl --set-default-version 2 后重新检查。'
  return '修复 WSL 2 后重新检查。'
}
