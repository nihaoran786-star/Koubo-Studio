import { CHAMBERS, type ChamberId } from '@/lib/chambers'

export interface ReturnToCreateTarget {
  projectId: string
  chamberId: ChamberId
}

export interface ResolvedReturnToCreateTarget extends ReturnToCreateTarget {
  chamberIndex: number
}

export function resolveReturnToCreateTarget(
  target: ReturnToCreateTarget | null,
  projectIds: string[],
): ResolvedReturnToCreateTarget | null {
  if (!target) return null
  if (!projectIds.includes(target.projectId)) return null

  const chamber = CHAMBERS.find((item) => item.id === target.chamberId)
  if (!chamber) return null

  return {
    ...target,
    chamberIndex: chamber.index,
  }
}
