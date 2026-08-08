export type WindowsRuntimeInstallResult =
  | {
      status: 'ok'
      source: 'windows_runtime_install'
      restartRequired: boolean
      message: string
    }
  | {
      status: 'error'
      source: 'windows_runtime_install' | 'desktop_required'
      error: {
        code: string
        message: string
      }
    }

interface TauriInstallResponse {
  status?: 'ok' | 'error'
  source?: 'tauri_wsl_installer'
  restartRequired?: boolean
  message?: string
  error?: {
    code?: string
    message?: string
  }
}

export function createWindowsRuntimeInstallClient() {
  return {
    installWsl: async (): Promise<WindowsRuntimeInstallResult> => {
      if (!isTauriDesktop()) {
        return {
          status: 'error',
          source: 'desktop_required',
          error: {
            code: 'desktop_required',
            message: '安装 WSL 需要在口播智能体桌面端中执行。',
          },
        }
      }

      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const response = await invoke<TauriInstallResponse>('install_wsl')
        if (!isTauriInstallResponse(response)) {
          return {
            status: 'error',
            source: 'windows_runtime_install',
            error: {
              code: 'invalid_response',
              message: 'Windows 安装程序返回了无法识别的状态。',
            },
          }
        }
        if (response?.status === 'error') {
          return {
            status: 'error',
            source: 'windows_runtime_install',
            error: {
              code: response.error?.code ?? 'wsl_install_failed',
              message: response.error?.message ?? response.message ?? 'WSL 安装未完成。',
            },
          }
        }

        return {
          status: 'ok',
          source: 'windows_runtime_install',
          restartRequired: Boolean(response?.restartRequired),
          message: response?.message ?? 'WSL 安装命令已启动。',
        }
      } catch (error) {
        return {
          status: 'error',
          source: 'windows_runtime_install',
          error: {
            code: 'wsl_install_failed',
            message: errorMessage(error, 'WSL 安装未完成。'),
          },
        }
      }
    },
  }
}

export function isTauriInstallResponse(value: unknown): value is TauriInstallResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as TauriInstallResponse
  if (candidate.source !== 'tauri_wsl_installer' || !candidate.status) return false
  if (candidate.status === 'ok') {
    return typeof candidate.restartRequired === 'boolean'
      && typeof candidate.message === 'string'
      && candidate.message.trim().length > 0
  }
  return typeof candidate.error?.code === 'string'
    && candidate.error.code.trim().length > 0
    && typeof candidate.error.message === 'string'
    && candidate.error.message.trim().length > 0
}

function errorMessage(error: unknown, fallback: string) {
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}

function isTauriDesktop() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
