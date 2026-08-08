import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { getRenderArtifact, listRenderArtifacts, saveRenderArtifact } from '@/lib/artifacts/render-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { listAgentSessions } from '@/lib/agents/agent-session-index'
import {
  beginProjectStageOperation,
  createProjectState,
  getProjectState,
  markProjectStageOperationRunning,
  mutateProjectState,
} from '@/lib/project-state/project-state-service'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { emptyScript } from '@/lib/workspace'
import { generateHeyGemRender, getHeyGemTask } from './heygem-service'
import { readHeyGemTaskState, saveHeyGemTaskState } from './heygem-task'

const projectId = 'test-heygem-service'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

async function seedInputs(options: {
  approvalStatus?: 'draft' | 'approved'
  audioScriptArtifactId?: string
} = {}) {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  await writeAvatarFixture(workspace)
  await saveScriptArtifact({
    workspace,
    artifactId: 'script-001',
    sessionId: 'script-session-001',
    approvalStatus: options.approvalStatus ?? 'approved',
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
    status: 'ready',
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
  await createProjectState({
    projectId,
    script: {
      ...emptyScript(),
      artifactId: 'script-001',
      approvalStatus: options.approvalStatus ?? 'approved',
      title: '测试口播',
      hook: '开头',
      body: '这是一段测试文案。',
      caption: '测试字幕',
      tags: ['#测试'],
      generated: true,
    },
  })
  if ((options.approvalStatus ?? 'approved') === 'approved' && (options.audioScriptArtifactId ?? 'script-001') === 'script-001') {
    await mutateProjectState(projectId, {
      operation: 'select_artifact',
      stage: 'voice',
      artifactId: 'audio-001',
    })
  }
  return workspace
}

describe('generateHeyGemRender', () => {
  it('persists running before the synchronous adapter finishes', async () => {
    const workspace = await seedInputs()
    let finishAdapter: ((value: {
      status: 'ok'
      source: 'heygem'
      outputPath: string
      durationSeconds: number
    }) => void) | undefined
    let adapterOutputPath = ''
    const runAdapter = vi.fn((input) => {
      adapterOutputPath = input.outputPath
      return new Promise<{
        status: 'ok'
        source: 'heygem'
        outputPath: string
        durationSeconds: number
      }>((resolve) => {
        finishAdapter = resolve
      })
    })

    const generation = generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: okMediaProbe,
    })

    await vi.waitFor(async () => {
      await expect(readHeyGemTaskState(workspace, 'avatar-session-001')).resolves.toMatchObject({
        status: 'running',
        artifactId: expect.stringMatching(/^render-/),
      })
    })

    finishAdapter?.({
      status: 'ok',
      source: 'heygem',
      outputPath: adapterOutputPath,
      durationSeconds: 8,
    })
    await expect(generation).resolves.toMatchObject({ status: 'ok' })
  })

  it('passes artifact inputs to the adapter and saves a render artifact', async () => {
    const workspace = await seedInputs()
    const runAdapter = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'heygem' as const,
      outputPath: input.outputPath,
      durationSeconds: 8,
    }))

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: okMediaProbe,
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(runAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        workspacePath: workspace.rootPath,
        scriptArtifact: expect.objectContaining({ artifactId: 'script-001' }),
        audioArtifact: expect.objectContaining({ artifactId: 'audio-001' }),
        input: expect.objectContaining({ mode: 'standard' }),
        outputPath: expect.stringContaining('render'),
      }),
    )

    await expect(getRenderArtifact(workspace, result.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'render',
      status: 'ready',
      source: 'heygem',
      scriptArtifactId: 'script-001',
      audioArtifactId: 'audio-001',
      durationSeconds: 8,
    })
    await expect(readHeyGemTaskState(workspace, 'avatar-session-001')).resolves.toMatchObject({
      taskId: result.artifact.artifactId,
      artifactId: result.artifact.artifactId,
      status: 'ready',
    })
    await expect(listAgentSessions(workspace, { agentRole: 'digital_human' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'avatar-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'digital_human',
        artifactId: result.artifact.artifactId,
      }),
    ])
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: {
        digitalHuman: { status: 'ready', artifactId: result.artifact.artifactId, source: 'heygem' },
        edit: { status: 'needs_input' },
      },
    })
  })

  it('returns a typed error when required upstream artifacts are missing', async () => {
    await ensureProjectWorkspace(projectId, 'digital-human')

    await expect(
      generateHeyGemRender({
        projectId,
        sessionId: 'avatar-session-001',
        input: renderInput(),
        runAdapter: async () => {
          throw new Error('adapter should not run')
        },
      }),
    ).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'project_not_found',
      },
    })
  })

  it('rejects draft script artifacts before calling HeyGem', async () => {
    await seedInputs({ approvalStatus: 'draft' })
    const runAdapter = vi.fn()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'script_not_ready',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects audio artifacts generated from a different script', async () => {
    await seedInputs({ audioScriptArtifactId: 'script-other' })
    const runAdapter = vi.fn()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'audio_not_ready',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects unknown avatar asset ids before calling HeyGem', async () => {
    await seedInputs()

    await expect(
      generateHeyGemRender({
        projectId,
        sessionId: 'avatar-session-001',
        input: { avatarAssetId: 'avatar-404', mode: 'standard' },
        runAdapter: async () => {
          throw new Error('adapter should not run')
        },
      }),
    ).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'missing_avatar_asset',
      },
    })
  })

  it('rejects client-supplied upstream ids and file paths', async () => {
    await seedInputs()
    const runAdapter = vi.fn()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-forged-input',
      input: {
        avatarAssetId: 'avatar-001',
        mode: 'standard',
        scriptArtifactId: 'script-forged',
        audioArtifactId: 'audio-forged',
        avatar: { source: 'upload', id: 'forged', assetPath: 'C:/outside.mp4' },
      },
      runAdapter,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      error: { code: 'client_lineage_forbidden' },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('resolves the selected server-side avatar asset before calling the adapter', async () => {
    const workspace = await seedInputs()
    const avatarPath = path.join(workspace.filesPath, 'avatar', 'avatar-001.mp4')
    const runAdapter = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'heygem' as const,
      outputPath: input.outputPath,
      durationSeconds: 8,
    }))

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: okMediaProbe,
    })

    expect(result.status).toBe('ok')
    expect(runAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          avatar: expect.objectContaining({
            id: 'avatar-001',
            assetPath: path.resolve(avatarPath),
          }),
        }),
      }),
    )
  })

  it('rejects uploaded avatar paths outside the workspace files directory', async () => {
    const workspace = await seedInputs()
    const outsidePath = path.join(path.dirname(workspace.rootPath), 'outside.mp4')
    await writeAvatarFixture(workspace, { path: outsidePath, writeFile: false })

    await expect(
      generateHeyGemRender({
        projectId,
        sessionId: 'avatar-session-001',
        input: renderInput(),
        runAdapter: async () => {
          throw new Error('adapter should not run')
        },
      }),
    ).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'avatar_asset_path_escape',
      },
    })
  })

  it('rejects missing uploaded avatar files before calling HeyGem', async () => {
    const workspace = await seedInputs()
    await writeAvatarFixture(workspace, {
      path: path.join(workspace.filesPath, 'avatar', 'avatar-404.mp4'),
      relativePath: 'files/avatar/avatar-404.mp4',
      writeFile: false,
    })
    const runAdapter = vi.fn()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'avatar_asset_missing',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects unreadable uploaded avatar videos before calling HeyGem', async () => {
    const workspace = await seedInputs()
    const runAdapter = vi.fn()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter,
      probeMedia: async () => ({
        status: 'failed',
        error: {
          code: 'media_probe_failed',
          message: 'Invalid data found when processing input',
        },
      }),
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'heygem_service',
      error: {
        code: 'avatar_asset_probe_failed',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('records a failed render artifact when the adapter fails', async () => {
    const workspace = await seedInputs()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter: async () => ({
        status: 'adapter_error',
        source: 'heygem',
        error: {
          code: 'runtime_timeout',
          message: 'HeyGem 生成超时',
        },
      }),
      probeMedia: okMediaProbe,
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'runtime_timeout',
      },
      artifact: {
        artifactType: 'render',
        status: 'failed',
      },
    })

    await expect(listRenderArtifacts(workspace)).resolves.toEqual([
      expect.objectContaining({
        artifactType: 'render',
        status: 'failed',
        error: {
          code: 'runtime_timeout',
          message: 'HeyGem 生成超时',
        },
      }),
    ])
    await expect(readHeyGemTaskState(workspace, 'avatar-session-001')).resolves.toMatchObject({
      artifactId: result.artifact?.artifactId,
      status: 'failed',
      error: {
        code: 'runtime_timeout',
        message: 'HeyGem 生成超时',
      },
    })
    await expect(listAgentSessions(workspace, { agentRole: 'digital_human' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'avatar-session-001',
        sessionKind: 'main',
        agentRole: 'digital_human',
        artifactId: result.artifact?.artifactId,
      }),
    ])
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { digitalHuman: { status: 'failed', error: { code: 'runtime_timeout' } } },
    })
  })

  it('persists a thrown runtime error as failed instead of leaving running', async () => {
    const workspace = await seedInputs()

    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-session-001',
      input: renderInput(),
      runAdapter: async () => {
        throw new Error('Duix connection reset')
      },
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'runtime_failed', message: 'Duix connection reset' },
      artifact: { status: 'failed' },
    })
    await expect(readHeyGemTaskState(workspace, 'avatar-session-001')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'runtime_failed', message: 'Duix connection reset' },
    })
  })

  it('does not start the runtime when the queued task cannot be persisted and fails the project operation', async () => {
    await seedInputs()
    const runAdapter = vi.fn()
    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-persist-queued',
      input: renderInput(),
      createOperationId: () => 'render-persist-queued',
      runAdapter,
      saveTask: async () => {
        throw new Error('task disk full')
      },
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'task_persist_failed' } })
    expect(runAdapter).not.toHaveBeenCalled()
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { digitalHuman: { status: 'failed', error: { code: 'task_persist_failed' } } },
    })
  })

  it('returns a stable failure and settles the same project operation when project completion fails', async () => {
    await seedInputs()
    const result = await generateHeyGemRender({
      projectId,
      sessionId: 'avatar-complete-failed',
      input: renderInput(),
      createOperationId: () => 'render-complete-failed',
      runAdapter: async ({ outputPath }) => ({ status: 'ok', source: 'heygem', outputPath, durationSeconds: 8 }),
      completeProjectStage: async () => {
        throw new Error('project write failed')
      },
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'project_stage_complete_failed' } })
    await expect(readHeyGemTaskState(await ensureProjectWorkspace(projectId, 'digital-human'), 'avatar-complete-failed')).resolves.toMatchObject({
      status: 'ready',
      artifactId: 'render-complete-failed',
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { digitalHuman: { status: 'failed', error: { code: 'project_stage_complete_failed' } } },
    })
  })
})

describe('getHeyGemTask recovery', () => {
  it('reconciles a valid ready video into project state and repeated GET is idempotent', async () => {
    const { outputPath } = await prepareReadyRecovery('render-recovered', 'avatar-recovered')
    await fs.writeFile(outputPath, 'valid video')

    const first = await getHeyGemTask({
      projectId,
      sessionId: 'avatar-recovered',
      now: '2026-07-17T00:06:00.000Z',
      probeMedia: okMediaProbe,
    })
    expect(first).toMatchObject({
      status: 'ok',
      task: { status: 'ready' },
      artifact: { artifactId: 'render-recovered' },
      project: {
        stages: {
          digitalHuman: {
            status: 'ready',
            artifactId: 'render-recovered',
            source: 'heygem',
            operation: {
              id: 'render-recovered',
              sessionId: 'avatar-recovered',
              upstreamArtifactId: 'audio-001',
            },
          },
        },
      },
    })
    if (first.status !== 'ok') throw new Error('expected ready task')
    const second = await getHeyGemTask({ projectId, sessionId: 'avatar-recovered', probeMedia: okMediaProbe })
    if (second.status !== 'ok') throw new Error('expected ready task')
    expect(second.project.revision).toBe(first.project.revision)
  })

  it('returns task_state_corrupt without overwriting a damaged task file', async () => {
    const workspace = await seedInputs()
    const taskPath = path.join(workspace.artifactsPath, 'render', '.heygem-task-avatar-corrupt.json')
    await fs.mkdir(path.dirname(taskPath), { recursive: true })
    await fs.writeFile(taskPath, '{broken json')

    await expect(getHeyGemTask({ projectId, sessionId: 'avatar-corrupt' })).resolves.toMatchObject({
      status: 'adapter_error',
      source: 'heygem_task',
      error: { code: 'task_state_corrupt' },
    })
    await expect(fs.readFile(taskPath, 'utf8')).resolves.toBe('{broken json')
  })

  it('fails only a stale matching project operation when its task is missing', async () => {
    await seedInputs()
    await beginProjectStageOperation({
      projectId,
      stage: 'digitalHuman',
      operationId: 'render-missing-task',
      sessionId: 'avatar-missing-task',
      source: 'heygem',
      expectedUpstreamArtifactId: 'audio-001',
      now: '2026-07-17T00:00:00.000Z',
    })
    const within = await getHeyGemTask({
      projectId,
      sessionId: 'avatar-missing-task',
      now: '2026-07-17T00:15:00.000Z',
      recoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(within).toMatchObject({ status: 'ok', project: { stages: { digitalHuman: { status: 'queued' } } } })
    const stale = await getHeyGemTask({
      projectId,
      sessionId: 'avatar-missing-task',
      now: '2026-07-17T00:15:00.001Z',
      recoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(stale).toMatchObject({
      status: 'ok',
      project: { stages: { digitalHuman: { status: 'failed', error: { code: 'task_interrupted' } } } },
    })
  })

  it('does not let a foreign session overwrite an active project operation', async () => {
    await seedInputs()
    await beginProjectStageOperation({
      projectId,
      stage: 'digitalHuman',
      operationId: 'render-owner',
      sessionId: 'avatar-owner',
      source: 'heygem',
      expectedUpstreamArtifactId: 'audio-001',
      now: '2026-07-17T00:00:00.000Z',
    })
    const before = await getProjectState(projectId)
    const result = await getHeyGemTask({
      projectId,
      sessionId: 'avatar-foreign',
      now: '2026-07-17T01:00:00.000Z',
      recoveryWindowMs: 0,
    })
    expect(result).toMatchObject({ status: 'ok', project: { stages: { digitalHuman: { status: 'queued' } } } })
    if (result.status !== 'ok') throw new Error('expected task query')
    expect(result.project.revision).toBe(before.revision)
  })

  it('does not return an old artifact after selecting a different upstream voice', async () => {
    const { workspace, outputPath } = await prepareReadyRecovery('render-old-voice', 'avatar-old-voice')
    await fs.writeFile(outputPath, 'valid old video')
    await getHeyGemTask({ projectId, sessionId: 'avatar-old-voice', probeMedia: okMediaProbe })
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-002',
      sessionId: 'voice-session-002',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-002.wav'),
      durationSeconds: 8,
      parameters: {
        scriptArtifactId: 'script-001',
        text: '这是一段测试文案。',
        speed: 1,
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav',
      },
    })
    await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-002' })
    const before = await getProjectState(projectId)

    const result = await getHeyGemTask({ projectId, sessionId: 'avatar-old-voice', probeMedia: okMediaProbe })
    expect(result).toMatchObject({
      status: 'ok',
      task: { status: 'ready', artifactId: 'render-old-voice' },
      artifact: undefined,
      project: {
        stages: {
          voice: { status: 'ready', artifactId: 'audio-002' },
          digitalHuman: { status: 'needs_input' },
        },
      },
    })
    if (result.status !== 'ok') throw new Error('expected task query')
    expect(result.project.revision).toBe(before.revision)
  })

  it.each([
    ['a newer operation in the same session', 'avatar-old-operation'],
    ['a newer operation in a different session', 'avatar-new-session'],
  ])('does not return an old artifact while %s owns the project stage', async (_label, nextSessionId) => {
    const oldSessionId = 'avatar-old-operation'
    const { outputPath } = await prepareReadyRecovery('render-old-operation', oldSessionId)
    await fs.writeFile(outputPath, 'valid old video')
    await getHeyGemTask({ projectId, sessionId: oldSessionId, probeMedia: okMediaProbe })
    await beginProjectStageOperation({
      projectId,
      stage: 'digitalHuman',
      operationId: 'render-new-operation',
      sessionId: nextSessionId,
      source: 'heygem',
      expectedUpstreamArtifactId: 'audio-001',
    })
    const before = await getProjectState(projectId)

    const result = await getHeyGemTask({ projectId, sessionId: oldSessionId, probeMedia: okMediaProbe })
    expect(result).toMatchObject({
      status: 'ok',
      task: { status: 'ready', artifactId: 'render-old-operation' },
      artifact: undefined,
      project: {
        stages: {
          digitalHuman: {
            status: 'queued',
            operation: { id: 'render-new-operation', sessionId: nextSessionId },
          },
        },
      },
    })
    if (result.status !== 'ok') throw new Error('expected task query')
    expect(result.project.revision).toBe(before.revision)
  })

  it.each([
    ['missing file', 'render-file-gone', 'avatar-file-gone', 'render_artifact_missing', undefined],
    ['empty file', 'render-empty', 'avatar-empty', 'render_artifact_empty', ''],
  ])('does not return a ready artifact with a %s', async (_label, artifactId, sessionId, errorCode, fileContent) => {
    const { outputPath } = await prepareReadyRecovery(artifactId, sessionId)
    if (fileContent !== undefined) await fs.writeFile(outputPath, fileContent)
    const first = await getHeyGemTask({ projectId, sessionId, probeMedia: okMediaProbe })
    expect(first).toMatchObject({
      status: 'ok',
      artifact: undefined,
      project: { stages: { digitalHuman: { status: 'failed', error: { code: errorCode } } } },
    })
    if (first.status !== 'ok') throw new Error('expected task query')
    const repeated = await getHeyGemTask({ projectId, sessionId, probeMedia: okMediaProbe })
    if (repeated.status !== 'ok') throw new Error('expected task query')
    expect(repeated.project.revision).toBe(first.project.revision)
  })

  it('rejects a video that cannot be probed or has no positive duration', async () => {
    const { outputPath } = await prepareReadyRecovery('render-bad-media', 'avatar-bad-media')
    await fs.writeFile(outputPath, 'not video')
    await expect(getHeyGemTask({
      projectId,
      sessionId: 'avatar-bad-media',
      probeMedia: async () => ({ status: 'ok', durationSeconds: 0 }),
    })).resolves.toMatchObject({
      status: 'ok',
      artifact: undefined,
      project: { stages: { digitalHuman: { status: 'failed', error: { code: 'render_artifact_probe_failed' } } } },
    })
  })

  it('rejects an artifact path outside the render root before probing it', async () => {
    const workspace = await seedInputs()
    await beginProjectStageOperation({
      projectId,
      stage: 'digitalHuman',
      operationId: 'render-escape',
      sessionId: 'avatar-escape',
      source: 'heygem',
      expectedUpstreamArtifactId: 'audio-001',
    })
    await markProjectStageOperationRunning({ projectId, stage: 'digitalHuman', operationId: 'render-escape' })
    await saveHeyGemTaskState({ workspace, sessionId: 'avatar-escape', taskId: 'render-escape', artifactId: 'render-escape', status: 'ready' })
    const escapedPath = path.join(workspace.rootPath, 'escaped.mp4')
    await fs.writeFile(escapedPath, 'outside render root')
    await saveRecoveredRender(workspace, 'render-escape', 'avatar-escape', escapedPath)
    const probeMedia = vi.fn(okMediaProbe)

    await expect(getHeyGemTask({ projectId, sessionId: 'avatar-escape', probeMedia })).resolves.toMatchObject({
      status: 'ok',
      artifact: undefined,
      project: { stages: { digitalHuman: { status: 'failed', error: { code: 'render_artifact_path_escape' } } } },
    })
    expect(probeMedia).not.toHaveBeenCalled()
  })
})

function renderInput() {
  return {
    avatarAssetId: 'avatar-001',
    mode: 'standard' as const,
  }
}

async function writeAvatarFixture(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  overrides: Partial<{ path: string; relativePath: string; status: 'ready' | 'failed'; writeFile: boolean }> = {},
) {
  const directory = path.join(workspace.filesPath, 'avatar')
  const avatarPath = overrides.path ?? path.join(directory, 'avatar-001.mp4')
  await fs.mkdir(directory, { recursive: true })
  if (overrides.writeFile !== false) {
    await fs.mkdir(path.dirname(avatarPath), { recursive: true })
    await fs.writeFile(avatarPath, 'avatar video')
  }
  await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({
    version: 1,
    assets: [{
      assetId: 'avatar-001', assetType: 'avatar', projectId, featureType: 'digital-human',
      originalFilename: 'avatar.mp4', contentType: 'video/mp4',
      relativePath: overrides.relativePath ?? 'files/avatar/avatar-001.mp4',
      path: avatarPath, size: 12, status: overrides.status ?? 'ready',
      createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    }],
  }), 'utf8')
  return avatarPath
}

async function prepareReadyRecovery(artifactId: string, sessionId: string) {
  const workspace = await seedInputs()
  await beginProjectStageOperation({
    projectId,
    stage: 'digitalHuman',
    operationId: artifactId,
    sessionId,
    source: 'heygem',
    expectedUpstreamArtifactId: 'audio-001',
    now: '2026-07-17T00:00:00.000Z',
  })
  await markProjectStageOperationRunning({ projectId, stage: 'digitalHuman', operationId: artifactId })
  await saveHeyGemTaskState({ workspace, sessionId, taskId: artifactId, artifactId, status: 'ready' })
  const outputPath = path.join(workspace.artifactsPath, 'render', `${artifactId}.mp4`)
  await saveRecoveredRender(workspace, artifactId, sessionId, outputPath)
  return { workspace, outputPath }
}

async function saveRecoveredRender(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  artifactId: string,
  sessionId: string,
  outputPath: string,
) {
  await saveRenderArtifact({
    workspace,
    artifactId,
    sessionId,
    status: 'ready',
    source: 'heygem',
    scriptArtifactId: 'script-001',
    audioArtifactId: 'audio-001',
    outputPath,
    durationSeconds: 8,
    avatar: { source: 'library', id: 'a1', name: '林夕' },
    mode: 'standard',
  })
}

const okMediaProbe = async () => ({
  status: 'ok' as const,
  durationSeconds: 8,
})
