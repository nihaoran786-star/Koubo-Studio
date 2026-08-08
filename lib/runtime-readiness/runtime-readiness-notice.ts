import type { ChamberId } from '@/lib/chambers'
import type {
  RuntimeReadinessApiResult,
  RuntimeReadinessCheck,
} from './runtime-readiness-types'

export interface RuntimeReadinessNotice {
  id: string
  title: string
  message: string
  action: string
  actionLabel: string
  tone: 'warning' | 'error'
}

const CHAMBER_CHECK: Record<ChamberId, string> = {
  idea: 'model_provider',
  voice: 'indextts2',
  avatar: 'heygem',
  render: 'post_production',
  publish: 'browser_publish',
}

export function buildRuntimeReadinessNotice(
  result: RuntimeReadinessApiResult | undefined,
  chamberId: ChamberId,
): RuntimeReadinessNotice | undefined {
  if (!result || result.status === 'error') return undefined
  const check = result.checks.find((item) => item.id === CHAMBER_CHECK[chamberId])
  if (!check || check.status === 'ready') return undefined

  return {
    id: `runtime_readiness_${check.id}`,
    title: `${check.title} 运行环境未就绪`,
    message: firstGapOrNextStep(check),
    action: check.nextStep,
    actionLabel: '打开设置',
    tone: check.status === 'missing' ? 'error' : 'warning',
  }
}

function firstGapOrNextStep(check: RuntimeReadinessCheck) {
  return check.gaps[0] ?? check.nextStep
}
