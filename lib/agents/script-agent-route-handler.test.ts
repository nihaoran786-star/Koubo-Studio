import { describe, expect, it } from 'vitest'
import type { ApproveScriptArtifactResult, RunScriptAgentResult } from './script-agent-service'
import { handleScriptAgentPatch, handleScriptAgentPost } from './script-agent-route-handler'

const okResult: RunScriptAgentResult = {
  status: 'ok',
  source: 'script_agent',
  turnType: 'generate_artifact',
  projectId: 'project-001',
  featureType: 'digital-human',
  agent: {
    status: 'ok',
    source: 'model_agent',
    projectId: 'project-001',
    featureType: 'digital-human',
    sessionId: 'pi-session-001',
    workspacePath: '/tmp/project-001',
    reply: '{}',
  },
  reply: '{}',
  artifact: {
    artifactId: 'script-001',
    artifactType: 'script',
    projectId: 'project-001',
    featureType: 'digital-human',
    sessionId: 'pi-session-001',
    approvalStatus: 'draft',
    content: {
      title: '标题',
      hook: '钩子',
      body: '正文',
      caption: '平台文案',
      tags: ['#AI'],
      durationSeconds: 30,
      voiceNotes: '',
      shotNotes: '',
      riskNotes: '',
    },
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  },
  record: {
    artifactId: 'script-001',
    artifactType: 'script',
    projectId: 'project-001',
    featureType: 'digital-human',
    sessionId: 'pi-session-001',
    agentRole: 'script',
    status: 'draft',
    path: '/tmp/project-001/artifacts/script/script-001.json',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  },
}

function request(body: unknown) {
  return new Request('http://localhost/api/projects/project-001/script-agent', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function patchRequest(body: unknown) {
  return new Request('http://localhost/api/projects/project-001/script-agent', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

describe('handleScriptAgentPost', () => {
  it('calls script agent service and returns ok response', async () => {
    const response = await handleScriptAgentPost(request({
      message: '做一条 Codex 入门 30 秒口播',
      turnType: 'clarify',
      promptName: 'script',
      approvalStatus: 'draft',
      artifactId: 'script-001',
    }), {
      projectId: 'project-001',
      runAgent: async (input) => {
        expect(input).toMatchObject({
          projectId: 'project-001',
          message: '做一条 Codex 入门 30 秒口播',
          turnType: 'clarify',
          promptName: 'script',
          approvalStatus: 'draft',
          artifactId: 'script-001',
        })
        return okResult
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'script_agent',
      artifact: {
        artifactId: 'script-001',
      },
    })
  })

  it('rejects empty message', async () => {
    const response = await handleScriptAgentPost(request({
      message: '   ',
      approvalStatus: 'draft',
    }), {
      projectId: 'project-001',
      runAgent: async () => okResult,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'empty_message',
      },
    })
  })

  it('rejects invalid approvalStatus', async () => {
    const response = await handleScriptAgentPost(request({
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'ready',
    }), {
      projectId: 'project-001',
      runAgent: async () => okResult,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'invalid_approval_status',
      },
    })
  })

  it('rejects invalid turnType', async () => {
    const response = await handleScriptAgentPost(request({
      message: '做一条 Codex 入门 30 秒口播',
      turnType: 'chat',
      approvalStatus: 'draft',
    }), {
      projectId: 'project-001',
      runAgent: async () => okResult,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      error: {
        code: 'invalid_turn_type',
      },
    })
  })

  it('returns 422 for script parse errors', async () => {
    const response = await handleScriptAgentPost(request({
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
    }), {
      projectId: 'project-001',
      runAgent: async () => ({
        status: 'script_parse_error',
        source: 'script_agent',
        turnType: 'generate_artifact',
        projectId: 'project-001',
        featureType: 'digital-human',
        reply: 'not json',
        error: {
          code: 'script_parse_error',
          message: 'Pi 回复 JSON 格式无效',
        },
      }),
    })

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      status: 'script_parse_error',
      source: 'script_agent',
      error: {
        code: 'script_parse_error',
      },
    })
  })

  it('keeps needs_configuration error code with server status', async () => {
    const response = await handleScriptAgentPost(request({
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
    }), {
      projectId: 'project-001',
      runAgent: async () => ({
        status: 'needs_configuration',
        source: 'model_agent',
        projectId: 'project-001',
        featureType: 'digital-human',
        workspacePath: '/tmp/project-001',
        reply: '',
        error: {
          code: 'missing_credentials',
          message: 'Provider 需要 API Key。',
        },
      }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      status: 'needs_configuration',
      source: 'model_agent',
      error: {
        code: 'missing_credentials',
      },
    })
  })
})

describe('handleScriptAgentPatch', () => {
  it('approves an existing script artifact', async () => {
    const approved: ApproveScriptArtifactResult = {
      status: 'ok',
      source: 'script_agent',
      artifact: {
        ...okResult.artifact,
        approvalStatus: 'approved',
      },
      record: {
        ...okResult.record,
        status: 'ready',
      },
    }
    const response = await handleScriptAgentPatch(patchRequest({ artifactId: 'script-001' }), {
      projectId: 'project-001',
      approveScript: async (input) => {
        expect(input).toEqual({
          projectId: 'project-001',
          artifactId: 'script-001',
        })
        return approved
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      artifact: {
        artifactId: 'script-001',
        approvalStatus: 'approved',
      },
      record: {
        status: 'ready',
      },
    })
  })

  it('rejects missing artifact id during approval', async () => {
    const response = await handleScriptAgentPatch(patchRequest({ artifactId: ' ' }), {
      projectId: 'project-001',
      approveScript: async () => {
        throw new Error('should not approve')
      },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      error: {
        code: 'missing_artifact_id',
      },
    })
  })
})
