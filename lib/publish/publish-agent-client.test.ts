import { describe, expect, it, vi } from 'vitest'
import { createPublishAgentClient, publishAgentEndpoint, publishPackageEndpoint, statusFromPublishAgentResult } from './publish-agent-client'

describe('publish agent client', () => {
  it('prepares a local publish package through POST', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: 'ready',
      source: 'local_publish_package',
      nextStep: 'manual_browser_required',
      artifact: { artifactId: 'publish-001' },
    }), { status: 200 }))
    const client = createPublishAgentClient(fetcher as typeof fetch)

    const result = await client.prepare({
      projectId: 'project-001',
      sessionId: 'publish-session-001',
      input: { platforms: ['douyin'] },
    })

    expect(fetcher).toHaveBeenCalledWith(publishAgentEndpoint('project-001'), expect.objectContaining({ method: 'POST' }))
    expect(result.status).toBe('ready')
    expect(statusFromPublishAgentResult(result)).toBe('ready')
  })

  it('reports visible-browser manual supervision from health', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: 'manual_required',
      source: 'visible_browser',
      supportedPlatforms: ['douyin', 'xiaohongshu'],
      message: '需要用户监督',
    }), { status: 200 }))
    await expect(createPublishAgentClient(fetcher as typeof fetch).health({ projectId: 'project-001' }))
      .resolves.toMatchObject({ status: 'manual_required' })
  })

  it('loads the selected local publish package after returning to the page', async () => {
    const fetcher = vi.fn(async () => Response.json({
      status: 'ready',
      source: 'local_publish_package',
      nextStep: 'manual_browser_required',
      artifact: { artifactId: 'publish-001' },
    }))
    const result = await createPublishAgentClient(fetcher as typeof fetch).load({
      projectId: 'project-001',
      artifactId: 'publish-001',
    })

    expect(fetcher).toHaveBeenCalledWith(publishPackageEndpoint('project-001', 'publish-001'), undefined)
    expect(result).toMatchObject({ status: 'ready', artifact: { artifactId: 'publish-001' } })
  })
})
