import { describe, expect, it } from 'vitest'
import { handleHeyGemGet, handleHeyGemPost } from './heygem-route-handler'
import type { GenerateHeyGemRenderResult, GetHeyGemTaskResult } from './heygem-service'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'

describe('handleHeyGemPost', () => {
  it('returns generated render artifacts', async () => {
    const response = await handleHeyGemPost(
      new Request('http://localhost/api/projects/demo/digital-human/heygem', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'avatar-session-001',
          input: {
            avatarAssetId: 'avatar-001',
            mode: 'standard',
          },
        }),
      }),
      {
        projectId: 'demo',
        generateRender: async () =>
          ({
            status: 'ok',
            source: 'heygem_service',
            artifact: {
              artifactId: 'render-001',
              artifactType: 'render',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'avatar-session-001',
              status: 'ready',
              source: 'heygem',
              scriptArtifactId: 'script-001',
              audioArtifactId: 'audio-001',
              outputPath: 'render/render-001.mp4',
              durationSeconds: 8,
              avatar: {
                source: 'library',
                id: 'a1',
                name: '林夕',
              },
              mode: 'standard',
              createdAt: '2026-06-11T00:00:00.000Z',
              updatedAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies GenerateHeyGemRenderResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'heygem_service',
      artifact: {
        artifactType: 'render',
        scriptArtifactId: 'script-001',
        audioArtifactId: 'audio-001',
      },
    })
  })

  it('rejects invalid request bodies with a typed error', async () => {
    const response = await handleHeyGemPost(
      new Request('http://localhost/api/projects/demo/digital-human/heygem', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: '',
          input: {},
        }),
      }),
      {
        projectId: 'demo',
        generateRender: async () => {
          throw new Error('should not be called')
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'invalid_session_id',
      },
    })
  })
})

describe('handleHeyGemGet', () => {
  it('returns the persisted task state for refresh recovery', async () => {
    const response = await handleHeyGemGet(
      new Request('http://localhost/api/projects/demo/digital-human/heygem?sessionId=avatar-session-001'),
      {
        projectId: 'demo',
        getTask: async () => ({
          status: 'ok',
          source: 'heygem_task',
          task: {
            taskId: 'render-001',
            projectId: 'demo',
            sessionId: 'avatar-session-001',
            status: 'running',
            artifactId: 'render-001',
            createdAt: '2026-06-11T00:00:00.000Z',
            updatedAt: '2026-06-11T00:00:01.000Z',
          },
          project: {} as ProjectStateDocument,
        }) satisfies GetHeyGemTaskResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      task: { status: 'running', artifactId: 'render-001' },
    })
  })

  it('rejects a missing session id', async () => {
    const response = await handleHeyGemGet(
      new Request('http://localhost/api/projects/demo/digital-human/heygem'),
      { projectId: 'demo' },
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_session_id' },
    })
  })
})
