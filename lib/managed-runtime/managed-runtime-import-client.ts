export type ManagedRuntimeActionResult =
  | {
      status: 'ok'
      source: 'managed_wsl_action'
      message: string
      version: string | null
      sha256: string | null
    }
  | {
      status: 'cancelled'
      source: 'managed_wsl_action'
      sha256: null
      message?: string
    }
  | {
      status: 'error'
      source: 'managed_wsl_action' | 'desktop_required'
      error: { code: string; message: string }
    }

interface TauriImportResponse {
  status?: 'ok' | 'cancelled' | 'running' | 'stopped' | 'absent' | 'failed'
  message?: string
  version?: string | null
  sha256?: string | null
  error?: { code?: string; message?: string }
}

export function createManagedRuntimeImportClient() {
  return {
    importPackage: async (): Promise<ManagedRuntimeActionResult> => {
      if (!isTauriDesktop()) {
        return {
          status: 'error',
          source: 'desktop_required',
          error: {
            code: 'desktop_required',
            message: '导入数字人运行包需要在口播智能体桌面端中执行。',
          },
        }
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const response = await invoke<TauriImportResponse>('import_koubo_runtime')
        if (response?.status === 'cancelled') {
          if (response.sha256 !== null) {
            return importError('invalid_response', '桌面端返回了无效的取消导入结果。')
          }
          return { status: 'cancelled', source: 'managed_wsl_action', sha256: null }
        }
        if (response?.status !== 'ok') {
          return importError('invalid_response', '桌面端没有返回有效的运行包导入结果。')
        }
        if (typeof response.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(response.sha256)) {
          return importError('invalid_response', '桌面端没有返回有效的运行包 SHA-256。')
        }
        return {
          status: 'ok',
          source: 'managed_wsl_action',
          message: response.message ?? '数字人运行包已导入。',
          version: response.version ?? null,
          sha256: response.sha256,
        }
      } catch (error) {
        const detail = errorDetail(error, 'runtime_import_failed', '数字人运行包导入失败。')
        return importError(detail.code, detail.message)
      }
    },
    startRuntime: () => invokeLifecycle('start_koubo_runtime', '启动', 'running'),
    stopRuntime: () => invokeLifecycle('stop_koubo_runtime', '停止', 'stopped'),
    uninstallRuntime: () => invokeLifecycle('uninstall_koubo_runtime', '移除', 'absent'),
  }
}

async function invokeLifecycle(
  command: 'start_koubo_runtime' | 'stop_koubo_runtime' | 'uninstall_koubo_runtime',
  label: string,
  expectedStatus: 'running' | 'stopped' | 'absent',
): Promise<ManagedRuntimeActionResult> {
  if (!isTauriDesktop()) {
    return {
      status: 'error', source: 'desktop_required',
      error: { code: 'desktop_required', message: `${label}数字人运行环境需要在口播智能体桌面端中执行。` },
    }
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const response = await invoke<TauriImportResponse>(command)
    if (response?.status === 'cancelled') {
      return {
        status: 'cancelled', source: 'managed_wsl_action', sha256: null,
        message: response.message ?? `已取消${label}数字人运行环境。`,
      }
    }
    if (response?.status === 'failed') {
      return importError(
        response.error?.code ?? 'runtime_action_failed',
        response.error?.message ?? response.message ?? `数字人运行环境${label}失败。`,
      )
    }
    if (response?.status !== expectedStatus) return importError('invalid_response', `桌面端没有返回有效的${label}结果。`)
    return {
      status: 'ok', source: 'managed_wsl_action',
      message: response.message ?? `数字人运行环境已${label}。`, version: response.version ?? null,
      sha256: null,
    }
  } catch (error) {
    const detail = errorDetail(error, 'runtime_action_failed', `数字人运行环境${label}失败。`)
    return importError(detail.code, detail.message)
  }
}

function importError(code: string, message: string): ManagedRuntimeActionResult {
  return { status: 'error', source: 'managed_wsl_action', error: { code, message } }
}

function errorDetail(error: unknown, fallbackCode: string, fallbackMessage: string) {
  if (typeof error === 'string' && error.trim()) return { code: fallbackCode, message: error.trim() }
  if (error instanceof Error && error.message.trim()) return { code: fallbackCode, message: error.message.trim() }
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown }
    const code = typeof value.code === 'string' && value.code.trim() ? value.code.trim() : fallbackCode
    const message = typeof value.message === 'string' && value.message.trim() ? value.message.trim() : fallbackMessage
    return { code, message }
  }
  return { code: fallbackCode, message: fallbackMessage }
}

function isTauriDesktop() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
