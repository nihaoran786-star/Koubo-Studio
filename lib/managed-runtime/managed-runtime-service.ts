import { probeManagedRuntime } from './managed-runtime-adapter'
import {
  MANAGED_RUNTIME_API_URL,
  MANAGED_RUNTIME_NAME,
  type ManagedRuntimeError,
  type ManagedRuntimeProbe,
  type ManagedRuntimeReport,
  type ManagedRuntimeStatus,
} from './managed-runtime-types'

export async function inspectManagedRuntime({
  probe = probeManagedRuntime,
  now = () => new Date(),
}: {
  probe?: () => Promise<ManagedRuntimeProbe>
  now?: () => Date
} = {}): Promise<ManagedRuntimeReport> {
  let raw: ManagedRuntimeProbe
  try {
    raw = await probe()
  } catch {
    return report('failed', null, 'unknown', null, 'not_checked', {
      code: 'probe_failed',
      message: '无法检查数字人运行环境。',
    }, now())
  }

  if (!raw.list.ok) {
    return report('failed', null, 'unknown', null, 'not_checked', {
      code: 'probe_failed',
      message: '无法读取 WSL 发行版列表。',
    }, now())
  }

  if (!raw.distro) {
    return report('absent', null, 'absent', null, 'not_checked', null, now())
  }

  if (raw.distro.wslVersion !== 2) {
    return report('failed', raw.distro.wslVersion, raw.distro.state, null, 'not_checked', {
      code: 'unsupported_wsl_version',
      message: 'KouboRuntime 必须运行在 WSL 2，当前检测到 WSL 1。',
    }, now())
  }

  if (raw.distro.state === 'unknown') {
    return report('failed', 2, 'unknown', null, 'not_checked', {
      code: 'unknown_distro_state',
      message: '无法识别 KouboRuntime 的 WSL 运行状态。',
    }, now())
  }

  if (raw.distro.state === 'stopped') {
    return report('stopped', 2, 'stopped', null, 'not_checked', null, now())
  }

  if (!raw.manifestCommand?.ok) {
    return report('failed', 2, 'running', null, 'not_checked', {
      code: 'manifest_unavailable',
      message: 'KouboRuntime 已运行，但无法读取运行包清单。',
    }, now())
  }

  if (!raw.manifest) {
    return report('failed', 2, 'running', null, 'not_checked', {
      code: 'manifest_invalid',
      message: 'KouboRuntime 运行包清单损坏或与当前软件不兼容。',
    }, now())
  }

  if (!raw.health.checked || !raw.health.ok) {
    return report('running', 2, 'running', raw.manifest.version, 'unhealthy', {
      code: 'health_unavailable',
      message: 'KouboRuntime 已启动，但数字人服务尚未就绪。',
    }, now())
  }

  return report('ready', 2, 'running', raw.manifest.version, 'healthy', null, now())
}

function report(
  status: ManagedRuntimeStatus,
  wslVersion: number | null,
  distroState: ManagedRuntimeReport['runtime']['distroState'],
  version: string | null,
  health: ManagedRuntimeReport['runtime']['health'],
  error: ManagedRuntimeError | null,
  now: Date,
): ManagedRuntimeReport {
  const installed = status !== 'absent' && wslVersion !== null
  return {
    status,
    source: 'managed_runtime_probe',
    checkedAt: now.toISOString(),
    runtime: {
      name: MANAGED_RUNTIME_NAME,
      installed,
      distroState,
      wslVersion,
      version,
      apiUrl: MANAGED_RUNTIME_API_URL,
      health,
    },
    actions: {
      canImport: status === 'absent',
      canStart: status === 'stopped',
      canStop: installed && distroState === 'running',
      canUninstall: installed,
    },
    error,
  }
}

