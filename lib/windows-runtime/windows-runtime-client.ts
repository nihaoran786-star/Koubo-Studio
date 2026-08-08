import { requestJson } from '@/lib/api/api-fetch'

export type WindowsRuntimeGrade = 'unsuitable' | 'usable' | 'smooth'
export type WindowsRuntimeCheckStatus = 'ready' | 'warning' | 'missing' | 'unknown'

export interface WindowsRuntimeCheck {
  id: string
  title: string
  status: WindowsRuntimeCheckStatus
  detail: string
  action?: string
}

export interface WindowsRuntimeAssessment {
  grade: WindowsRuntimeGrade
  label: string
  summary: string
}

export interface WindowsRuntimeInstallState {
  wslInstalled: boolean
  restartRequired: boolean
  kouboRuntimeInstalled: boolean
  canInstallWsl: boolean
}

export type WindowsRuntimeResult =
  | {
      status: 'ok'
      source: 'windows_runtime'
      assessment: WindowsRuntimeAssessment
      checks: WindowsRuntimeCheck[]
      install: WindowsRuntimeInstallState
    }
  | {
      status: 'error'
      source: 'windows_runtime'
      error: {
        code: string
        message: string
      }
    }

type Fetcher = typeof fetch

export function createWindowsRuntimeClient(fetcher: Fetcher = fetch) {
  return {
    get: async (): Promise<WindowsRuntimeResult> => {
      const result = await requestJson<unknown>('/api/settings/windows-runtime', {
        fetcher,
        init: { method: 'GET' },
        fallback: (error) => ({
          status: 'error',
          source: 'windows_runtime',
          error: {
            code: error.code,
            message: error.message,
          },
        }),
      })
      return isWindowsRuntimeResult(result)
        ? result
        : {
            status: 'error',
            source: 'windows_runtime',
            error: {
              code: 'invalid_response',
              message: 'Windows 环境体检返回了无法识别的数据。',
            },
          }
    },
  }
}

function isWindowsRuntimeResult(value: unknown): value is WindowsRuntimeResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WindowsRuntimeResult>
  if (candidate.source !== 'windows_runtime') return false
  if (candidate.status === 'error') {
    return isNonEmptyString(candidate.error?.code)
      && isNonEmptyString(candidate.error?.message)
  }
  if (candidate.status !== 'ok') return false

  const assessment = candidate.assessment
  const install = candidate.install
  return Boolean(
    assessment
      && ['unsuitable', 'usable', 'smooth'].includes(assessment.grade)
      && isNonEmptyString(assessment.label)
      && isNonEmptyString(assessment.summary)
      && Array.isArray(candidate.checks)
      && candidate.checks.every(isWindowsRuntimeCheck)
      && install
      && typeof install.wslInstalled === 'boolean'
      && typeof install.restartRequired === 'boolean'
      && typeof install.kouboRuntimeInstalled === 'boolean'
      && typeof install.canInstallWsl === 'boolean',
  )
}

function isWindowsRuntimeCheck(value: unknown): value is WindowsRuntimeCheck {
  if (!value || typeof value !== 'object') return false
  const check = value as Partial<WindowsRuntimeCheck>
  return isNonEmptyString(check.id)
    && isNonEmptyString(check.title)
    && ['ready', 'warning', 'missing', 'unknown'].includes(check.status ?? '')
    && isNonEmptyString(check.detail)
    && (check.action === undefined || isNonEmptyString(check.action))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
