import { describe, expect, it, vi } from 'vitest'
import { createDesktopRuntimeClient } from './desktop-runtime-client'

describe('desktop runtime client', () => {
  it('fetches project desktop runtime health', async () => {
    const response = {
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'dev_server',
      capabilities: ['script_agent'],
      requirements: [],
    }
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createDesktopRuntimeClient(fetcher)

    await expect(client.health({ projectId: 'project-001' })).resolves.toEqual(response)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-001/desktop-runtime', {
      method: 'GET',
    })
  })

  it('returns desktop_backend_missing when the local API route cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createDesktopRuntimeClient(fetcher)

    await expect(client.health({ projectId: 'project-001' })).resolves.toMatchObject({
      status: 'unavailable',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_missing',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})
