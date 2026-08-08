import type { LocalRuntimeConfig, LocalRuntimeConfigPatch } from '@/lib/runtime-data/runtime-config-store'

export type RuntimeReadinessCheckStatus = 'ready' | 'missing' | 'warning'

export interface RuntimeReadinessCheck {
  id: string
  title: string
  status: RuntimeReadinessCheckStatus
  requiredForCurrentProfile: boolean
  optionalForCurrentProfile: boolean
  gaps: string[]
  nextStep: string
  provisioning: {
    priority: number
    stage: string
    required: string[]
    sensitiveEnvKeys: string[]
    safeEvidence: string
  }
  remediation: {
    envKeys: string[]
    envTemplate: string
    command: string
    docPath: string
    links?: Array<{
      label: string
      url: string
      note?: string
    }>
  }
}

export type RuntimeReadinessProfileId = 'base' | 'local_enhanced' | 'publish_enhanced' | 'remote_runtime' | 'full'

export interface RuntimeReadinessProfile {
  id: RuntimeReadinessProfileId
  title: string
  description: string
  requiredCheckIds: string[]
}

export interface RuntimeReadinessResult {
  status: 'ready' | 'missing'
  source: 'runtime_readiness'
  profile: RuntimeReadinessProfile
  updatedAt: string
  summary: Record<RuntimeReadinessCheckStatus, number>
  checks: RuntimeReadinessCheck[]
  /** API route 返回时总是存在；service 层的纯检测结果不携带持久化配置。 */
  localRuntimeConfig?: LocalRuntimeConfig
}

export interface RuntimeReadinessErrorResult {
  status: 'error'
  source: 'runtime_readiness'
  profile?: RuntimeReadinessProfile
  summary: Record<RuntimeReadinessCheckStatus, number>
  checks: RuntimeReadinessCheck[]
  error: {
    code: 'runtime_readiness_error'
    message: string
  }
}

export type RuntimeReadinessApiResult = RuntimeReadinessResult | RuntimeReadinessErrorResult

export interface RuntimeReadinessUpdateInput {
  profileId?: RuntimeReadinessProfileId
  localRuntimeConfig?: LocalRuntimeConfigPatch
}
