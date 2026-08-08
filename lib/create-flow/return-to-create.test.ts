import { describe, expect, it } from 'vitest'
import { resolveReturnToCreateTarget } from './return-to-create'

describe('resolveReturnToCreateTarget', () => {
  it('resolves an existing project and chamber', () => {
    expect(
      resolveReturnToCreateTarget(
        { projectId: 'project-1', chamberId: 'voice' },
        ['project-1'],
      ),
    ).toEqual({
      projectId: 'project-1',
      chamberId: 'voice',
      chamberIndex: 1,
    })
  })

  it('drops stale project return targets', () => {
    expect(
      resolveReturnToCreateTarget(
        { projectId: 'missing-project', chamberId: 'voice' },
        ['project-1'],
      ),
    ).toBeNull()
  })

  it('returns null when no target exists', () => {
    expect(resolveReturnToCreateTarget(null, ['project-1'])).toBeNull()
  })
})
