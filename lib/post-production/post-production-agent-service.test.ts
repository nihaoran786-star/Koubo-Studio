import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { listAgentSessions } from '@/lib/agents/agent-session-index'
import { getPostProductionArtifact, listPostProductionArtifacts } from '@/lib/artifacts/post-production-artifact'
import { saveRenderArtifact } from '@/lib/artifacts/render-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { getPostProductionTask, runPostProductionAgent } from './post-production-agent-service'
import { createDefaultEditPlan } from './edit-plan'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import { getProjectState } from '@/lib/project-state/project-state-service'
import { readPostProductionTaskState } from './post-production-task'

const projectId = 'test-post-production-agent'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

async function seedInputs(options: {
  scriptApprovalStatus?: 'draft' | 'approved'
  audioScriptArtifactId?: string
  audioStatus?: 'ready' | 'failed'
  renderStatus?: 'ready' | 'failed'
  renderOutputPath?: string
  writeRenderOutput?: boolean
} = {}) {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const renderOutputPath = options.renderOutputPath ?? path.join(workspace.artifactsPath, 'render', 'render-001.mp4')
  await saveScriptArtifact({
    workspace,
    artifactId: 'script-001',
    sessionId: 'script-session-001',
    approvalStatus: options.scriptApprovalStatus ?? 'approved',
    content: {
      title: '测试口播',
      hook: '开头',
      body: '这是一段测试文案。',
      caption: '测试字幕',
      tags: ['#测试'],
      durationSeconds: 8,
      voiceNotes: '自然',
      shotNotes: '正面',
      riskNotes: '',
    },
  })
  await saveAudioArtifact({
    workspace,
    artifactId: 'audio-001',
    sessionId: 'voice-session-001',
    status: options.audioStatus ?? 'ready',
    source: 'indextts2',
    outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'),
    durationSeconds: 8,
    parameters: {
      scriptArtifactId: options.audioScriptArtifactId ?? 'script-001',
      text: '这是一段测试文案。',
      speed: 1,
      emotionAlpha: 0.2,
      useRandom: false,
      outputFormat: 'wav',
    },
  })
  await saveRenderArtifact({
    workspace,
    artifactId: 'render-001',
    sessionId: 'avatar-session-001',
    status: options.renderStatus ?? 'ready',
    source: 'heygem',
    scriptArtifactId: 'script-001',
    audioArtifactId: 'audio-001',
    outputPath: renderOutputPath,
    durationSeconds: 8,
    avatar: {
      source: 'library',
      id: 'a1',
      name: '林夕',
    },
    mode: 'standard',
  })
  if (options.writeRenderOutput !== false) {
    await fs.mkdir(path.dirname(renderOutputPath), { recursive: true })
    await fs.writeFile(renderOutputPath, 'fake render video')
  }
  const now = '2026-06-11T00:00:00.000Z'
  const project: ProjectStateDocument = {
    version: 1,
    revision: 1,
    projectId,
    title: '测试口播',
    status: 'editing',
    currentStep: 'render',
    furthestStep: 'render',
    stages: {
      script: { status: 'ready', artifactId: 'script-001', updatedAt: now },
      voice: { status: 'ready', artifactId: 'audio-001', source: 'indextts2', updatedAt: now },
      digitalHuman: {
        status: 'ready', artifactId: 'render-001', source: 'heygem',
        operation: { id: 'render-001', sessionId: 'avatar-session-001', upstreamArtifactId: 'audio-001', startedAt: now },
        updatedAt: now,
      },
      edit: { status: 'needs_input', updatedAt: now },
      publish: { status: 'idle', updatedAt: now },
    },
    script: {} as ProjectStateDocument['script'],
    createdAt: now,
    updatedAt: now,
  }
  await fs.writeFile(path.join(workspace.rootPath, 'project.json'), JSON.stringify(project), 'utf8')
  return workspace
}

describe('runPostProductionAgent', () => {
  it('passes render and script context to the allowlisted skill runner and saves a post-production artifact', async () => {
    const workspace = await seedInputs()
    const runSkill = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'video_editing_skill' as const,
      outputPath: input.outputPath,
      subtitlePath: input.subtitlePath,
      coverPath: input.coverPath,
      durationSeconds: 8,
    }))

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: {
        ...baseInput(),
        request: '加字幕并整理成片',
      },
      runSkill,
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(runSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        workspacePath: workspace.rootPath,
        renderOutputPath: expect.stringContaining('render-001.mp4'),
        scriptText: '这是一段测试文案。',
        request: '加字幕并整理成片',
        outputPath: expect.stringContaining('post-production'),
        skill: expect.objectContaining({
          skillName: 'post-production-cut-review',
        }),
        plan: expect.objectContaining({ version: 1, ratio: '9:16' }),
      }),
    )
    await expect(getPostProductionArtifact(workspace, result.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'post-production',
      status: 'ready',
      renderArtifactId: 'render-001',
      scriptArtifactId: 'script-001',
      durationSeconds: 8,
    })
    await expect(listAgentSessions(workspace, { agentRole: 'post_production' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'post-session-001',
        sessionKind: 'subagent',
        parentSessionId: 'script-session-001',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'post_production',
        artifactId: result.artifact.artifactId,
      }),
    ])
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: {
        edit: {
          status: 'ready',
          artifactId: result.artifact.artifactId,
          source: 'local_ffmpeg',
          operation: { id: result.artifact.artifactId, sessionId: 'post-session-001', upstreamArtifactId: 'render-001' },
        },
      },
    })
    await expect(readPostProductionTaskState(workspace, 'post-session-001')).resolves.toMatchObject({
      status: 'ready', artifactId: result.artifact.artifactId,
    })
  })

  it('rejects a client supplied skill before running the controlled executor', async () => {
    await seedInputs()
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: {
        ...baseInput(),
        skill: {
          scriptPath: 'C:/untrusted/Invoke-Arbitrary.ps1',
        },
      },
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'client_skill_forbidden',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects an invalid EditPlan before running ffmpeg', async () => {
    await seedInputs()
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: {
        ...baseInput(),
        plan: { ...createDefaultEditPlan(), audio: { voiceVolume: 99 } },
      },
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'invalid_voice_volume',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('selects the controlled local ffmpeg executor on the server', async () => {
    await seedInputs()
    const runSkill = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'video_editing_skill' as const,
      outputPath: input.outputPath,
      subtitlePath: input.subtitlePath,
      coverPath: input.coverPath,
      durationSeconds: 8,
    }))

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: {
        ...baseInput(),
        request: '加字幕并整理成片',
      },
      runSkill,
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result.status).toBe('ok')
    expect(runSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: expect.objectContaining({
          skillId: 'builtin:post-production-cut-review',
          skillName: 'post-production-cut-review',
        }),
      }),
    )
  })

  it('does not call the model in manual mode', async () => {
    await seedInputs()
    const generatePlan = vi.fn()
    const runSkill = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'video_editing_skill' as const,
      outputPath: input.outputPath,
      subtitlePath: input.subtitlePath,
      coverPath: input.coverPath,
      durationSeconds: 8,
    }))

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      generatePlan,
      runSkill,
    })

    expect(result.status).toBe('ok')
    expect(generatePlan).not.toHaveBeenCalled()
    expect(runSkill).toHaveBeenCalledOnce()
  })

  it('generates an AI plan from safe business context and executes it with the same runner', async () => {
    await seedInputs()
    const generatedPlan = {
      ...createDefaultEditPlan(),
      subtitles: { enabled: true, style: 'bold' as const, maxCharsPerCue: 12 },
    }
    const generatePlan = vi.fn(async () => ({
      status: 'ok' as const,
      source: 'ai_edit_plan_agent' as const,
      plan: generatedPlan,
    }))
    const runSkill = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'video_editing_skill' as const,
      outputPath: input.outputPath,
      subtitlePath: input.subtitlePath,
      coverPath: input.coverPath,
      durationSeconds: 8,
    }))

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: { ...baseInput(), mode: 'ai', request: '字幕要醒目' },
      generatePlan,
      runSkill,
    })

    expect(result.status).toBe('ok')
    expect(generatePlan).toHaveBeenCalledWith(expect.objectContaining({
      instruction: '字幕要醒目',
      script: '这是一段测试文案。',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      videoDurationSeconds: 8,
      cacheDirectory: expect.stringContaining('.ai-plan-cache'),
    }))
    expect(runSkill).toHaveBeenCalledWith(expect.objectContaining({ plan: generatedPlan }))
  })

  it('returns AI configuration errors without running ffmpeg', async () => {
    await seedInputs()
    const runSkill = vi.fn()
    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: { ...baseInput(), mode: 'ai' },
      generatePlan: async () => ({
        status: 'needs_configuration',
        source: 'ai_edit_plan_agent',
        error: { code: 'ai_provider_missing_credentials', message: '请配置默认 Provider。' },
      }),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'ai_edit_plan_agent',
      error: { code: 'ai_provider_missing_credentials' },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('returns a typed error when the render artifact is missing', async () => {
    await ensureProjectWorkspace(projectId, 'digital-human')

    await expect(
      runPostProductionAgent({
        projectId,
        sessionId: 'post-session-001',
        input: {
          ...baseInput(),
          renderArtifactId: 'render-404',
          request: '加字幕',
        },
        runSkill: async () => {
          throw new Error('skill should not run')
        },
      }),
    ).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'missing_render_artifact',
      },
    })
  })

  it('rejects failed render artifacts before calling the skill', async () => {
    await seedInputs({ renderStatus: 'failed' })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'missing_render_artifact',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects draft script artifacts before calling the skill', async () => {
    await seedInputs({ scriptApprovalStatus: 'draft' })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'script_not_approved',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects render artifacts when the audio belongs to a different script', async () => {
    await seedInputs({ audioScriptArtifactId: 'script-other' })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'audio_script_mismatch',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects render artifacts whose audio artifact is not ready before calling the skill', async () => {
    await seedInputs({ audioStatus: 'failed' })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'audio_artifact_not_ready',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects render artifacts whose output video is missing before calling the skill', async () => {
    await seedInputs({ writeRenderOutput: false })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'render_output_missing',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('rejects render output paths outside the workspace render artifact directory', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const outsidePath = path.join(path.dirname(workspace.rootPath), 'outside-render.mp4')
    await seedInputs({ renderOutputPath: outsidePath, writeRenderOutput: false })
    const runSkill = vi.fn()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      runSkill,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'post_production_agent',
      error: {
        code: 'render_output_path_escape',
      },
    })
    expect(runSkill).not.toHaveBeenCalled()
  })

  it('records a failed post-production artifact when the skill fails', async () => {
    const workspace = await seedInputs()

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: {
        ...baseInput(),
        request: '加字幕',
      },
      runSkill: async () => ({
        status: 'skill_error',
        source: 'video_editing_skill',
        error: {
          code: 'skill_timeout',
          message: '视频剪辑 skill 运行超时',
        },
      }),
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result).toMatchObject({
      status: 'skill_error',
      artifact: {
        artifactType: 'post-production',
        status: 'failed',
      },
    })
    await expect(listPostProductionArtifacts(workspace)).resolves.toEqual([
      expect.objectContaining({
        artifactType: 'post-production',
        status: 'failed',
        error: {
          code: 'skill_timeout',
          message: '视频剪辑 skill 运行超时',
        },
      }),
    ])
    await expect(listAgentSessions(workspace, { agentRole: 'post_production' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'post-session-001',
        sessionKind: 'subagent',
        parentSessionId: 'script-session-001',
        agentRole: 'post_production',
        artifactId: result.artifact?.artifactId,
      }),
    ])
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { edit: { status: 'failed', error: { code: 'skill_timeout' } } },
    })
    await expect(readPostProductionTaskState(workspace, 'post-session-001')).resolves.toMatchObject({
      status: 'failed', error: { code: 'skill_timeout' },
    })
  })

  it('recovers a ready edit only after the output file passes media validation', async () => {
    const workspace = await seedInputs()
    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session-001',
      input: baseInput(),
      createOperationId: () => 'post-recover',
      runSkill: async (skillInput) => {
        await fs.mkdir(path.dirname(skillInput.outputPath), { recursive: true })
        await fs.writeFile(skillInput.outputPath, 'valid output')
        return { status: 'ok', source: 'video_editing_skill', outputPath: skillInput.outputPath, durationSeconds: 8 }
      },
    })
    expect(result.status).toBe('ok')

    const recovered = await getPostProductionTask({
      projectId,
      sessionId: 'post-session-001',
      probeMedia: async () => ({ status: 'ok', durationSeconds: 8 }),
    })
    expect(recovered).toMatchObject({
      status: 'ok',
      task: { status: 'ready', artifactId: 'post-recover' },
      artifact: { artifactId: 'post-recover' },
      project: { stages: { edit: { status: 'ready', artifactId: 'post-recover' } } },
    })

    await fs.rm(path.join(workspace.artifactsPath, 'post-production', 'post-recover.mp4'))
    const invalid = await getPostProductionTask({
      projectId,
      sessionId: 'post-session-001',
      probeMedia: async () => ({ status: 'ok', durationSeconds: 8 }),
    })
    expect(invalid).toMatchObject({
      status: 'ok',
      project: { stages: { edit: { status: 'failed', error: { code: 'edit_artifact_invalid' } } } },
    })
    expect(invalid.status === 'ok' ? invalid.artifact : undefined).toBeUndefined()
  })
})

function baseInput() {
  return {
    renderArtifactId: 'render-001',
    request: '加字幕',
    mode: 'manual' as const,
    plan: createDefaultEditPlan(),
  }
}
