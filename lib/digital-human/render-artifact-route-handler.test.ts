import { describe, expect, it, vi } from 'vitest'
import { handleRenderArtifactFileGet } from './render-artifact-route-handler'

describe('render artifact file route handler', () => {
  it('returns render video bytes', async () => {
    const response = await handleRenderArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/render-artifacts/render-001/file'),
      {
        projectId: 'demo',
        artifactId: 'render-001',
        openFile: vi.fn(async () => new Response('render-video', {
          headers: { 'content-type': 'video/mp4' },
        })),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(await response.text()).toBe('render-video')
  })

  it('returns structured errors', async () => {
    const response = await handleRenderArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/render-artifacts/render-001/file'),
      {
        projectId: 'demo',
        artifactId: 'render-001',
        openFile: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      status: 'render_artifact_error',
      source: 'render_artifact_file',
      error: {
        code: 'unexpected_error',
      },
    })
  })
})
