import { describe, expect, it, vi } from 'vitest'
import { handlePostProductionArtifactFileGet } from './post-production-artifact-route-handler'

describe('post-production artifact file route handler', () => {
  it('returns video bytes by default', async () => {
    const response = await handlePostProductionArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/post-production-artifacts/post-001/file'),
      {
        projectId: 'demo',
        artifactId: 'post-001',
        openFile: vi.fn(async () => new Response('video', {
          headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' },
        })),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('video')
  })

  it('passes cover kind through to the file reader', async () => {
    const openFile = vi.fn(async () => new Response('cover', {
      headers: { 'content-type': 'image/png', 'accept-ranges': 'bytes' },
    }))

    const response = await handlePostProductionArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/post-production-artifacts/post-001/file?kind=cover'),
      {
        projectId: 'demo',
        artifactId: 'post-001',
        openFile,
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(await response.text()).toBe('cover')
    expect(openFile).toHaveBeenCalledWith({
      projectId: 'demo',
      artifactId: 'post-001',
      kind: 'cover',
      rangeHeader: undefined,
    })
  })

  it('returns partial video bytes with HTTP 206 headers', async () => {
    const response = await handlePostProductionArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/post-production-artifacts/post-001/file', {
        headers: { range: 'bytes=2-4' },
      }),
      {
        projectId: 'demo',
        artifactId: 'post-001',
        openFile: vi.fn(async () => new Response('deo', {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': 'bytes 2-4/8',
            'content-length': '3',
            'accept-ranges': 'bytes',
          },
        })),
      },
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-4/8')
    expect(response.headers.get('content-length')).toBe('3')
  })

  it('returns structured errors', async () => {
    const response = await handlePostProductionArtifactFileGet(
      new Request('http://127.0.0.1/api/projects/demo/post-production-artifacts/post-001/file'),
      {
        projectId: 'demo',
        artifactId: 'post-001',
        openFile: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      status: 'post_production_artifact_error',
      source: 'post_production_artifact_file',
      error: {
        code: 'unexpected_error',
      },
    })
  })
})
