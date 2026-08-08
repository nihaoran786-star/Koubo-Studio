import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { RunModelAgentResult } from './model-agent-service'
import { listAgentSessions } from './agent-session-index'
import { approveScriptArtifactForProject, runScriptAgent } from './script-agent-service'
import { beginProjectStageOperation, createProjectState, getProjectState } from '@/lib/project-state/project-state-service'
import { emptyScript } from '@/lib/workspace'

const projectId = 'test-script-agent-service'
const workspaceRoot = path.join(process.cwd(), 'data', 'workspaces', projectId)

const modelOk = (reply: string): RunModelAgentResult => ({
  status: 'ok',
  source: 'model_agent',
  projectId,
  featureType: 'digital-human',
  sessionId: 'pi-session-001',
  workspacePath: workspaceRoot,
  reply,
})

const validReply = JSON.stringify({
  title: 'Codex 入门第一课',
  hook: '如果你刚开始接触 Codex，先把目标说清楚。',
  body: '第一步，是告诉它你要做什么、项目在哪里、希望它先检查什么。',
  caption: '从一句清楚的目标开始，让 AI 帮你推进任务。',
  tags: ['#Codex', '#AI编程'],
  durationSeconds: 30,
  voiceNotes: '自然、清晰、稳定。',
  shotNotes: '正面半身数字人口播，字幕分句出现。',
  riskNotes: '',
})

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('runScriptAgent', () => {
  it('makes the voice stage immediately enterable only after project-backed approval', async () => {
    await createProjectState({ projectId, script: emptyScript() })
    const generated = await runScriptAgent({
      projectId,
      message: '生成待确认文案',
      approvalStatus: 'draft',
      artifactId: 'script-to-approve',
      runAgent: async () => modelOk(validReply),
    })
    expect(generated.status).toBe('ok')

    const approved = await approveScriptArtifactForProject({ projectId, artifactId: 'script-to-approve' })
    expect(approved).toMatchObject({ status: 'ok', artifact: { approvalStatus: 'approved' } })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      script: { artifactId: 'script-to-approve', approvalStatus: 'approved' },
      stages: { script: { status: 'ready', artifactId: 'script-to-approve' } },
    })
    await expect(beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-next', sessionId: 'voice-next', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-to-approve',
    })).resolves.toMatchObject({ stages: { voice: { status: 'queued' } } })
  })

  it('returns a retryable structured error when project sync fails and succeeds on retry', async () => {
    await createProjectState({ projectId, script: emptyScript() })
    await runScriptAgent({
      projectId,
      message: '生成待确认文案',
      approvalStatus: 'draft',
      artifactId: 'script-retry',
      runAgent: async () => modelOk(validReply),
    })
    const failed = await approveScriptArtifactForProject({
      projectId,
      artifactId: 'script-retry',
      approveProjectScript: async () => { throw new Error('project disk busy') },
    })
    expect(failed).toMatchObject({
      status: 'artifact_error',
      error: { code: 'project_script_sync_failed', retryable: true, message: expect.stringContaining('project disk busy') },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({ stages: { script: { status: 'needs_input' } } })
    await expect(approveScriptArtifactForProject({ projectId, artifactId: 'script-retry' })).resolves.toMatchObject({ status: 'ok' })
    await expect(getProjectState(projectId)).resolves.toMatchObject({ stages: { script: { status: 'ready', artifactId: 'script-retry' } } })
  })

  it('calls Pi, parses structured JSON, and saves a script artifact', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      promptName: 'script',
      approvalStatus: 'draft',
      artifactId: 'script-001',
      now: '2026-06-11T00:00:00.000Z',
      runAgent: async () => modelOk(validReply),
    })

    expect(result.status).toBe('ok')
    expect(result.source).toBe('script_agent')
    if (result.status !== 'ok' || result.turnType !== 'generate_artifact') throw new Error('expected generated artifact')
    expect(result.agent.sessionId).toBe('pi-session-001')
    expect(result.artifact.artifactId).toBe('script-001')
    expect(result.artifact.content.title).toBe('Codex 入门第一课')
    expect(result.record.status).toBe('draft')

    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await expect(getScriptArtifact(workspace, 'script-001')).resolves.toEqual(result.artifact)
    await expect(listAgentSessions(workspace, { agentRole: 'script' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'pi-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'script',
        artifactId: 'script-001',
      }),
    ])
  })

  it('extracts JSON from fenced Pi replies', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'approved',
      artifactId: 'script-approved',
      runAgent: async () => modelOk(`这里是结果：\n\`\`\`json\n${validReply}\n\`\`\``),
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.turnType !== 'generate_artifact') throw new Error('expected generated artifact')
    expect(result.record.status).toBe('ready')
    expect(result.artifact.approvalStatus).toBe('approved')
  })

  it('saves a conservative editable draft when Pi never returns JSON', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
      runAgent: async () => modelOk('这不是 JSON'),
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.turnType !== 'generate_artifact') throw new Error('expected generated artifact')
    expect(result.artifact.content.title).toBe('Codex 入门口播')
    expect(result.artifact.content.riskNotes).toContain('非结构化内容')
  })

  it('reprompts Pi once when the generated script reply is not structured JSON', async () => {
    const calls: string[] = []
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
      artifactId: 'script-repaired',
      runAgent: async (input) => {
        calls.push(input.message)
        return calls.length === 1
          ? modelOk('我建议先从 Codex 的使用场景讲起，但这不是 JSON。')
          : modelOk(validReply)
      },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok' || result.turnType !== 'generate_artifact') throw new Error('expected generated artifact')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('上一轮没有生成可写入左侧文案模块的严格 JSON')
    expect(calls[1]).toContain('不要 Markdown 代码块')
    expect(result.artifact.artifactId).toBe('script-repaired')
    expect(result.agent.sessionId).toBe('pi-session-001')
  })

  it('returns plain Pi replies for clarification turns and records the script session', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '用户想做 Codex 入门视频，请追问一个关键问题。',
      turnType: 'clarify',
      approvalStatus: 'draft',
      runAgent: async () => modelOk('这条视频主要想给刚入门的新手看，还是给已经会用 AI 工具的创作者看？'),
    })

    expect(result).toMatchObject({
      status: 'ok',
      source: 'script_agent',
      turnType: 'clarify',
      reply: '这条视频主要想给刚入门的新手看，还是给已经会用 AI 工具的创作者看？',
      clarification: {
        readiness: 'unknown',
        canGenerate: false,
      },
    })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const sessions = await listAgentSessions(workspace, { agentRole: 'script' })
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'pi-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'script',
      }),
    ])
    expect('artifactId' in sessions[0]).toBe(false)
    await expect(getScriptArtifact(workspace, 'script-001')).rejects.toBeTruthy()
  })

  it('parses machine-readable clarification readiness from Pi JSON replies', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '用户已经补充了受众和语气，请判断是否可以生成文案。',
      turnType: 'clarify',
      approvalStatus: 'draft',
      runAgent: async () =>
        modelOk(JSON.stringify({
          reply: '信息已经够了，我可以开始写第一版文案。',
          readiness: 'ready_to_generate',
        })),
    })

    expect(result).toMatchObject({
      status: 'ok',
      turnType: 'clarify',
      reply: '信息已经够了，我可以开始写第一版文案。',
      clarification: {
        readiness: 'ready_to_generate',
        canGenerate: true,
      },
    })
  })


  it('returns script_parse_error when required script fields are missing', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
      runAgent: async () =>
        modelOk(
          JSON.stringify({
            title: '缺字段文案',
          }),
        ),
    })

    expect(result.status).toBe('script_parse_error')
  })

  it('passes through Pi needs_configuration without parsing reply', async () => {
    const result = await runScriptAgent({
      projectId,
      message: '做一条 Codex 入门 30 秒口播',
      approvalStatus: 'draft',
      runAgent: async () => ({
        status: 'needs_configuration',
        source: 'model_agent',
        projectId,
        featureType: 'digital-human',
        workspacePath: workspaceRoot,
        reply: '',
        error: {
          code: 'missing_credentials',
          message: 'Provider 需要 API Key。',
        },
      }),
    })

    expect(result).toMatchObject({
      status: 'needs_configuration',
      source: 'model_agent',
      error: {
        code: 'missing_credentials',
      },
    })
  })

})
