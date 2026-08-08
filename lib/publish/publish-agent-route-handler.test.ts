import { describe, expect, it, vi } from 'vitest'
import { handlePublishAgentGet, handlePublishAgentPatch, handlePublishAgentPost } from './publish-agent-route-handler'

describe('publish agent route handler', () => {
  it('exposes manual browser readiness', async () => {
    const response = await handlePublishAgentGet({ projectId: 'project-001' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'manual_required',
      supportedPlatforms: ['douyin', 'xiaohongshu'],
    })
  })

  it('returns a prepared local package result', async () => {
    const runAgent = vi.fn(async () => ({
      status: 'ready' as const,
      source: 'local_publish_package' as const,
      nextStep: 'manual_browser_required' as const,
      artifact: {
        artifactId: 'publish-001', artifactType: 'publish-package' as const, projectId: 'project-001',
        featureType: 'digital-human' as const, sessionId: 'publish-session-001', status: 'ready' as const,
        source: 'local_publish_package' as const, postProductionArtifactId: 'post-001', scriptArtifactId: 'script-001',
        videoPath: 'video.mp4', platforms: [], createdAt: '', updatedAt: '',
      },
    }))
    const response = await handlePublishAgentPost(new Request('http://local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'publish-session-001', input: { platforms: ['douyin'] } }),
    }), { projectId: 'project-001', runAgent })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ready', source: 'local_publish_package' })
  })

  it('does not expose legacy retry behavior', async () => {
    const response = await handlePublishAgentPatch()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ status: 'manual_required' })
  })
})
