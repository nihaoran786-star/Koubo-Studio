import { describe, expect, it, vi } from 'vitest'
import { emptyScript } from '@/lib/workspace'
import { createProjectStateClient, projectStateEndpoint } from './project-state-client'

describe('project state client', () => {
  it('builds encoded project state endpoints', () => {
    expect(projectStateEndpoint('project one')).toBe('/api/projects/project%20one/state')
  })

  it('sends only controlled mutation JSON', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', source: 'project_state', project: {} }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const client = createProjectStateClient(fetcher)
    await client.create({ projectId: 'project-001', script: emptyScript() })
    await client.mutate('project-001', { operation: 'set_current_step', step: 'voice', expectedRevision: 1 })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/projects/project-001/state', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ operation: 'set_current_step', step: 'voice', expectedRevision: 1 }),
    }))
  })
})
