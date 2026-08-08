import { inspectManagedRuntime } from './managed-runtime-service'
import type { ManagedRuntimeReport } from './managed-runtime-types'

export type ManagedRuntimeDto =
  | {
      status: 'ok'
      source: 'managed_wsl'
      runtime: {
        phase: ManagedRuntimeReport['status']
        installed: boolean
        running: boolean
        healthy: boolean
        version: string | null
        apiUrl: string | null
        detail: string
      }
      actions: ManagedRuntimeReport['actions']
      error: ManagedRuntimeReport['error']
    }
  | {
      status: 'error'
      source: 'managed_wsl'
      error: NonNullable<ManagedRuntimeReport['error']>
    }

export async function handleManagedRuntimeGet({
  inspect = inspectManagedRuntime,
}: {
  inspect?: () => Promise<ManagedRuntimeReport>
} = {}) {
  const report = await inspect()
  const dto = mapManagedRuntimeReport(report)
  return Response.json(dto, {
    status: dto.status === 'error' ? 500 : 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function mapManagedRuntimeReport(report: ManagedRuntimeReport): ManagedRuntimeDto {
  if (report.status === 'failed' && report.error?.code === 'probe_failed') {
    return { status: 'error', source: 'managed_wsl', error: report.error }
  }

  return {
    status: 'ok',
    source: 'managed_wsl',
    runtime: {
      phase: report.status,
      installed: report.runtime.installed,
      running: report.runtime.distroState === 'running',
      healthy: report.runtime.health === 'healthy',
      version: report.runtime.version,
      apiUrl: report.runtime.version ? report.runtime.apiUrl : null,
      detail: runtimeDetail(report),
    },
    actions: report.actions,
    error: report.error,
  }
}

function runtimeDetail(report: ManagedRuntimeReport) {
  if (report.status === 'absent') return '尚未导入 KouboRuntime 数字人运行包。'
  if (report.status === 'stopped') return 'KouboRuntime 已安装，当前未启动。'
  if (report.status === 'running') return report.error?.message ?? 'KouboRuntime 正在启动。'
  if (report.status === 'ready') {
    return `KouboRuntime ${report.runtime.version ?? ''} 已就绪。`.replace(/\s+已就绪/, ' 已就绪')
  }
  return report.error?.message ?? 'KouboRuntime 状态检查失败。'
}

