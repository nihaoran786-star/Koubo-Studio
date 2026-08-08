import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAudioArtifact, saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { listAgentSessions } from '@/lib/agents/agent-session-index'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import type { RunIndexTTS2Adapter } from './indextts2-adapter'
import { generateIndexTTS2Audio, getIndexTTS2Task } from './indextts2-service'
import { saveIndexTTS2TaskState } from './indextts2-task'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  createProjectState,
  getProjectState,
  markProjectStageOperationRunning,
} from '@/lib/project-state/project-state-service'
import { emptyScript } from '@/lib/workspace'

const projectId = 'test-indextts2-service'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('generateIndexTTS2Audio', () => {
  it('passes normalized parameters to the adapter and saves an audio artifact', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath, emotionRelativePath, referenceAbsolutePath, emotionAbsolutePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn(async (input) => {
      await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
      await fs.writeFile(input.outputPath, 'generated audio')
      return {
        status: 'ok' as const,
        source: 'indextts2' as const,
        outputPath: input.outputPath,
        durationSeconds: 8.5,
      }
    })
    const projectStatuses: string[] = []
    const taskStatuses: string[] = []

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '  今天测试 IndexTTS2 音频生成  ',
        speed: 1.15,
        emotionText: '自然稳定',
        emotionAlpha: 0.2,
        referenceAudioPath: referenceRelativePath,
        emotionReferenceAudioPath: emotionRelativePath,
        outputFormat: 'wav',
        useRandom: false,
        seed: 7,
        trimSeconds: 10,
      },
      runAdapter,
      probeMedia: okMediaProbe,
      saveTask: async (taskInput) => {
        taskStatuses.push(taskInput.status)
        return saveIndexTTS2TaskState(taskInput)
      },
      beginProjectStage: async (stageInput) => {
        const project = await beginProjectStageOperation(stageInput)
        projectStatuses.push(project.stages.voice.status)
        return project
      },
      markProjectStageRunning: async (stageInput) => {
        const project = await markProjectStageOperationRunning(stageInput)
        projectStatuses.push(project.stages.voice.status)
        return project
      },
      completeProjectStage: async (stageInput) => {
        const project = await completeProjectStageOperation(stageInput)
        projectStatuses.push(project.stages.voice.status)
        return project
      },
      createOperationId: () => 'audio-operation-001',
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.artifact.artifactId).toBe('audio-operation-001')
    expect(projectStatuses).toEqual(['queued', 'running', 'ready'])
    expect(taskStatuses).toEqual(['queued', 'running', 'ready'])
    expect(runAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        parameters: expect.objectContaining({
          text: '今天测试 IndexTTS2 音频生成',
          scriptArtifactId: 'script-001',
          referenceAudioPath: referenceAbsolutePath,
          speed: 1.15,
          emotionText: '自然稳定',
          emotionAlpha: 0.2,
          emotionReferenceAudioPath: emotionAbsolutePath,
          seed: 7,
          trimSeconds: 10,
        }),
        outputPath: expect.stringContaining('audio'),
      }),
    )

    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await expect(getAudioArtifact(workspace, result.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'audio',
      status: 'ready',
      durationSeconds: 8.5,
      parameters: expect.objectContaining({
        referenceAudioPath: referenceRelativePath,
        emotionReferenceAudioPath: emotionRelativePath,
        trimSeconds: 10,
      }),
    })
    await expect(listAgentSessions(workspace, { agentRole: 'voice' })).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'voice-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'voice',
        artifactId: result.artifact.artifactId,
      }),
    ])
    await expect(getIndexTTS2Task({ projectId, sessionId: 'voice-session-001', probeMedia: okMediaProbe })).resolves.toMatchObject({
      status: 'ok',
      task: {
        status: 'ready',
        artifactId: result.artifact.artifactId,
      },
      artifact: {
        artifactId: result.artifact.artifactId,
        status: 'ready',
      },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: {
        voice: { status: 'ready', artifactId: result.artifact.artifactId, source: 'indextts2' },
        digitalHuman: { status: 'needs_input' },
      },
    })
  })

  it('uses the approved script artifact body instead of caller-provided text', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn(async (input) => ({
      status: 'ok' as const,
      source: 'indextts2' as const,
      outputPath: input.outputPath,
      durationSeconds: 8.5,
    }))

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '这段请求文案不应该进入真实音频 lineage',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
      probeMedia: okMediaProbe,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(runAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: expect.objectContaining({
          text: '今天测试 IndexTTS2 音频生成',
        }),
      }),
    )

    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await expect(getAudioArtifact(workspace, result.artifact.artifactId)).resolves.toMatchObject({
      parameters: expect.objectContaining({
        text: '今天测试 IndexTTS2 音频生成',
      }),
    })
  })

  it('returns a typed adapter error without writing a ready artifact', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试失败',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter: async () => ({
        status: 'adapter_error',
        source: 'indextts2',
        error: {
          code: 'runtime_missing',
          message: 'IndexTTS2 runtime 未配置',
        },
      }),
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'indextts2',
      error: {
        code: 'runtime_missing',
      },
    })
    await expect(getIndexTTS2Task({ projectId, sessionId: 'voice-session-001' })).resolves.toMatchObject({
      status: 'ok',
      task: {
        status: 'failed',
        error: { code: 'runtime_missing' },
      },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { voice: { status: 'failed', error: { code: 'runtime_missing' } } },
    })
  })

  it('normalizes a thrown adapter error and persists a failed task', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-throw',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试异常',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter: async () => {
        throw new Error('runtime crashed')
      },
      probeMedia: okMediaProbe,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'indextts2',
      error: { code: 'runtime_failed', message: 'runtime crashed' },
    })
    await expect(getIndexTTS2Task({ projectId, sessionId: 'voice-session-throw' })).resolves.toMatchObject({
      task: {
        status: 'failed',
        error: { code: 'runtime_failed', message: 'runtime crashed' },
      },
    })
  })

  it('returns task_persist_failed without starting the runtime when the initial queued write fails', async () => {
    const base = await preparePersistenceInput('voice-persist-queued')
    const runAdapter = vi.fn()
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter,
      saveTask: async () => {
        throw new Error('disk unavailable')
      },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'indextts2_service',
      error: { code: 'task_persist_failed', message: expect.stringContaining('disk unavailable') },
    })
    expect(runAdapter).not.toHaveBeenCalled()
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { voice: { status: 'failed', error: { code: 'task_persist_failed' } } },
    })
  })

  it('terminalizes the queued task when persisting running state fails and does not start the runtime', async () => {
    const base = await preparePersistenceInput('voice-persist-running')
    const runAdapter = vi.fn()
    const statuses: string[] = []
    const saveTask: typeof saveIndexTTS2TaskState = async (taskInput) => {
      statuses.push(taskInput.status)
      if (taskInput.status === 'running') throw new Error('running write failed')
      return saveIndexTTS2TaskState(taskInput)
    }
    const result = await generateIndexTTS2Audio({ ...base, runAdapter, saveTask })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'task_persist_failed', message: expect.stringContaining('running write failed') },
    })
    expect(statuses).toEqual(['queued', 'running', 'failed'])
    expect(runAdapter).not.toHaveBeenCalled()
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId })).resolves.toMatchObject({
      task: { status: 'failed', error: { code: 'task_persist_failed' } },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { voice: { status: 'failed', error: { code: 'task_persist_failed' } } },
    })
  })

  it('returns task_persist_failed while retaining the original adapter error when terminal persistence fails', async () => {
    const base = await preparePersistenceInput('voice-persist-adapter-failed')
    const saveTask: typeof saveIndexTTS2TaskState = async (taskInput) => {
      if (taskInput.status === 'failed') throw new Error('terminal write failed')
      return saveIndexTTS2TaskState(taskInput)
    }
    const result = await generateIndexTTS2Audio({
      ...base,
      saveTask,
      runAdapter: async () => ({
        status: 'adapter_error',
        source: 'indextts2',
        error: { code: 'runtime_missing', message: 'IndexTTS2 runtime 未配置' },
      }),
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'indextts2_service',
      error: {
        code: 'task_persist_failed',
        message: expect.stringMatching(/runtime_missing.*IndexTTS2 runtime 未配置.*terminal write failed/),
      },
    })
  })

  it('terminalizes running state as artifact_persist_failed when audio artifact persistence fails', async () => {
    const base = await preparePersistenceInput('voice-persist-artifact')
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter: successfulAdapter,
      saveArtifact: async () => {
        throw new Error('artifact write failed')
      },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'artifact_persist_failed', message: expect.stringContaining('artifact write failed') },
    })
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId })).resolves.toMatchObject({
      task: { status: 'failed', error: { code: 'artifact_persist_failed' } },
    })
  })

  it('terminalizes running state as artifact_persist_failed when session metadata persistence fails', async () => {
    const base = await preparePersistenceInput('voice-persist-session')
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter: successfulAdapter,
      appendSessionMetadata: async () => {
        throw new Error('session index failed')
      },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'artifact_persist_failed', message: expect.stringContaining('session index failed') },
    })
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId })).resolves.toMatchObject({
      task: { status: 'failed', error: { code: 'artifact_persist_failed' } },
    })
  })

  it('best-effort terminalizes a failed ready write and returns task_persist_failed', async () => {
    const base = await preparePersistenceInput('voice-persist-ready')
    const statuses: string[] = []
    const saveTask: typeof saveIndexTTS2TaskState = async (taskInput) => {
      statuses.push(taskInput.status)
      if (taskInput.status === 'ready') throw new Error('ready write failed')
      return saveIndexTTS2TaskState(taskInput)
    }
    const result = await generateIndexTTS2Audio({ ...base, runAdapter: successfulAdapter, saveTask })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'task_persist_failed', message: expect.stringContaining('ready write failed') },
    })
    expect(statuses).toEqual(['queued', 'running', 'ready', 'failed'])
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId })).resolves.toMatchObject({
      task: { status: 'failed', error: { code: 'task_persist_failed' } },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { voice: { status: 'failed', error: { code: 'task_persist_failed' } } },
    })
  })

  it('returns task_persist_failed instead of throwing when artifact and terminal persistence both fail', async () => {
    const base = await preparePersistenceInput('voice-persist-double-failure')
    const saveTask: typeof saveIndexTTS2TaskState = async (taskInput) => {
      if (taskInput.status === 'failed') throw new Error('terminal write also failed')
      return saveIndexTTS2TaskState(taskInput)
    }
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter: successfulAdapter,
      saveTask,
      saveArtifact: async () => {
        throw new Error('artifact write failed')
      },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: {
        code: 'task_persist_failed',
        message: expect.stringMatching(/artifact write failed.*terminal write also failed/),
      },
    })
  })

  it('does not create a task or call the runtime when project begin fails', async () => {
    const base = await preparePersistenceInput('voice-project-begin-failed')
    const runAdapter = vi.fn()
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter,
      createOperationId: () => 'audio-project-begin-failed',
      beginProjectStage: async () => { throw new Error('project unavailable') },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'project_stage_begin_failed', message: expect.stringContaining('project unavailable') },
    })
    expect(runAdapter).not.toHaveBeenCalled()
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId })).resolves.toMatchObject({
      status: 'ok', source: 'indextts2_task', task: undefined, artifact: undefined,
      project: { stages: { voice: { status: 'needs_input' } } },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({ stages: { voice: { status: 'needs_input' } } })
  })

  it('returns an error and fails the same project operation when final project completion fails', async () => {
    const base = await preparePersistenceInput('voice-project-complete-failed')
    const operationId = 'audio-project-complete-failed'
    const result = await generateIndexTTS2Audio({
      ...base,
      runAdapter: successfulAdapter,
      createOperationId: () => operationId,
      completeProjectStage: async () => { throw new Error('project replace failed') },
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'project_stage_complete_failed', message: expect.stringContaining('project replace failed') },
    })
    await expect(getIndexTTS2Task({ projectId, sessionId: base.sessionId, probeMedia: okMediaProbe })).resolves.toMatchObject({
      task: { status: 'ready', artifactId: operationId },
    })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { voice: { status: 'ready', artifactId: operationId, source: 'indextts2' } },
    })
  })

  it('rejects missing script artifacts before calling IndexTTS2', async () => {
    const runAdapter = vi.fn()
    const beginProjectStage = vi.fn()
    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-missing',
        text: '测试未确认文案',
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
      beginProjectStage,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'script_artifact_missing',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
    expect(beginProjectStage).not.toHaveBeenCalled()
  })

  it('rejects draft script artifacts before calling IndexTTS2', async () => {
    await saveScript('script-draft', 'draft')
    const runAdapter = vi.fn()
    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-draft',
        text: '测试草稿文案',
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'script_not_approved',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects preset references that are not mapped to real audio files', async () => {
    await saveApprovedScript('script-001')
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试预设音色',
        referenceAudioPath: 'preset:清亮女声',
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_not_ready',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects reference audio paths outside the workspace before calling IndexTTS2', async () => {
    await saveApprovedScript('script-001')
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试越界路径',
        referenceAudioPath: path.resolve('outside.wav'),
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_path_escape',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects unreadable reference audio before calling IndexTTS2', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试无法读取的参考音频',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
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
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_probe_failed',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects reference audio shorter than 8 seconds before calling IndexTTS2', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试过短参考音频',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
      probeMedia: async () => ({
        status: 'ok',
        durationSeconds: 7.9,
      }),
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_duration_out_of_range',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects reference audio longer than 12 seconds before calling IndexTTS2', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试过长参考音频',
        referenceAudioPath: referenceRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
      probeMedia: async () => ({
        status: 'ok',
        durationSeconds: 12.1,
      }),
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_duration_out_of_range',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })

  it('rejects emotion reference audio outside 8-12 seconds before calling IndexTTS2', async () => {
    await saveApprovedScript('script-001')
    const { referenceRelativePath, emotionRelativePath } = await saveReferenceAudioFiles()
    const runAdapter = vi.fn()

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试过长情绪参考音频',
        referenceAudioPath: referenceRelativePath,
        emotionReferenceAudioPath: emotionRelativePath,
        speed: 1,
        emotionAlpha: 0.2,
        outputFormat: 'wav',
        useRandom: false,
      },
      runAdapter,
      probeMedia: async ({ filePath }) => ({
        status: 'ok',
        durationSeconds: String(filePath).endsWith('emotion.wav') ? 18 : 8,
      }),
    })

    expect(result).toMatchObject({
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'emotion_reference_audio_duration_out_of_range',
      },
    })
    expect(runAdapter).not.toHaveBeenCalled()
  })
})

describe('getIndexTTS2Task', () => {
  it('preserves a corrupt task state as a typed service error', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const taskPath = path.join(workspace.artifactsPath, 'audio', '.indextts2-task-corrupt-session.json')
    await fs.mkdir(path.dirname(taskPath), { recursive: true })
    await fs.writeFile(taskPath, '{not-json', 'utf8')

    await expect(getIndexTTS2Task({ projectId, sessionId: 'corrupt-session' })).resolves.toEqual({
      status: 'adapter_error',
      source: 'indextts2_task',
      error: {
        code: 'task_state_corrupt',
        message: 'IndexTTS2 任务状态文件已损坏，无法恢复任务状态。',
      },
    })
    await expect(fs.readFile(taskPath, 'utf8')).resolves.toBe('{not-json')
  })

  it('reconciles a persisted ready task into project state and repeated GET stays revision-idempotent', async () => {
    await saveApprovedScript('script-001')
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-recovered', sessionId: 'voice-recovered', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-recovered.wav'), durationSeconds: 8,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await fs.writeFile(path.join(workspace.artifactsPath, 'audio', 'audio-recovered.wav'), 'valid audio')
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-recovered', sessionId: 'voice-recovered', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-17T00:00:00.000Z',
    })
    await markProjectStageOperationRunning({ projectId, stage: 'voice', operationId: 'audio-recovered' })
    await saveIndexTTS2TaskState({
      workspace, sessionId: 'voice-recovered', taskId: 'audio-recovered', artifactId: 'audio-recovered', status: 'ready',
      now: '2026-07-17T00:05:00.000Z',
    })

    const first = await getIndexTTS2Task({
      projectId, sessionId: 'voice-recovered', now: '2026-07-17T00:06:00.000Z', probeMedia: okMediaProbe,
    })
    expect(first).toMatchObject({
      status: 'ok', task: { status: 'ready' }, artifact: { artifactId: 'audio-recovered' },
      project: { stages: { voice: { status: 'ready', artifactId: 'audio-recovered' } } },
    })
    if (first.status !== 'ok') throw new Error('expected ready task')
    const second = await getIndexTTS2Task({
      projectId, sessionId: 'voice-recovered', now: '2026-07-17T00:07:00.000Z', probeMedia: okMediaProbe,
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') throw new Error('expected ready task')
    expect(second.project.revision).toBe(first.project.revision)
  })

  it('reconciles only the matching active failed task and ignores a foreign missing session', async () => {
    await saveApprovedScript('script-001')
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-failed', sessionId: 'voice-owner', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-17T00:00:00.000Z',
    })
    const before = await getProjectState(projectId)
    const foreign = await getIndexTTS2Task({
      projectId, sessionId: 'voice-foreign', now: '2026-07-17T01:00:00.000Z', recoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(foreign).toMatchObject({ status: 'ok', project: { stages: { voice: { status: 'queued' } } } })
    if (foreign.status !== 'ok') throw new Error('expected task query')
    expect(foreign.project.revision).toBe(before.revision)

    await saveIndexTTS2TaskState({
      workspace, sessionId: 'voice-owner', taskId: 'audio-failed', status: 'failed',
      error: { code: 'runtime_failed', message: '运行时失败' }, now: '2026-07-17T00:01:00.000Z',
    })
    const failed = await getIndexTTS2Task({ projectId, sessionId: 'voice-owner', now: '2026-07-17T00:02:00.000Z' })
    expect(failed).toMatchObject({
      status: 'ok', project: { stages: { voice: { status: 'failed', error: { code: 'runtime_failed' } } } },
    })
  })

  it('fails a stale matching active project when its task file is missing but preserves it inside the window', async () => {
    await saveApprovedScript('script-001')
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-missing-task', sessionId: 'voice-missing-task', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-17T00:00:00.000Z',
    })
    const within = await getIndexTTS2Task({
      projectId, sessionId: 'voice-missing-task', now: '2026-07-17T00:15:00.000Z', recoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(within).toMatchObject({ status: 'ok', task: undefined, project: { stages: { voice: { status: 'queued' } } } })
    const stale = await getIndexTTS2Task({
      projectId, sessionId: 'voice-missing-task', now: '2026-07-17T00:15:00.001Z', recoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(stale).toMatchObject({
      status: 'ok', task: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'task_interrupted' } } } },
    })
  })

  it('returns a typed project failure when a ready task points to a missing audio artifact', async () => {
    await saveApprovedScript('script-001')
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-gone', sessionId: 'voice-gone', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001',
    })
    await saveIndexTTS2TaskState({
      workspace, sessionId: 'voice-gone', taskId: 'audio-gone', artifactId: 'audio-gone', status: 'ready',
    })
    const result = await getIndexTTS2Task({ projectId, sessionId: 'voice-gone' })
    expect(result).toMatchObject({
      status: 'ok', task: { status: 'ready' }, artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_missing' } } } },
    })
    if (result.status !== 'ok') throw new Error('expected task query')
    const repeated = await getIndexTTS2Task({ projectId, sessionId: 'voice-gone' })
    expect(repeated.status).toBe('ok')
    if (repeated.status !== 'ok') throw new Error('expected task query')
    expect(repeated.project.revision).toBe(result.project.revision)
  })

  it('fails recovery when the artifact output file is missing and stays idempotent', async () => {
    const { workspace } = await prepareReadyRecovery('audio-file-gone', 'voice-file-gone')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-file-gone', sessionId: 'voice-file-gone', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-file-gone.wav'), durationSeconds: 8,
      parameters: recoveredParameters(),
    })

    const first = await getIndexTTS2Task({ projectId, sessionId: 'voice-file-gone', probeMedia: okMediaProbe })
    expect(first).toMatchObject({
      status: 'ok', task: { status: 'ready' }, artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_missing' } } } },
    })
    if (first.status !== 'ok') throw new Error('expected task query')
    const second = await getIndexTTS2Task({ projectId, sessionId: 'voice-file-gone', probeMedia: okMediaProbe })
    if (second.status !== 'ok') throw new Error('expected task query')
    expect(second.project.revision).toBe(first.project.revision)
  })

  it('fails recovery when the artifact output file is empty', async () => {
    const { workspace, outputPath } = await prepareReadyRecovery('audio-empty', 'voice-empty')
    await fs.writeFile(outputPath, '')
    await saveRecoveredArtifact(workspace, 'audio-empty', 'voice-empty', outputPath)

    await expect(getIndexTTS2Task({ projectId, sessionId: 'voice-empty', probeMedia: okMediaProbe })).resolves.toMatchObject({
      status: 'ok', artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_empty' } } } },
    })
  })

  it('fails recovery when media probing fails', async () => {
    const { workspace, outputPath } = await prepareReadyRecovery('audio-bad', 'voice-bad')
    await fs.writeFile(outputPath, 'not valid media')
    await saveRecoveredArtifact(workspace, 'audio-bad', 'voice-bad', outputPath)

    await expect(getIndexTTS2Task({
      projectId,
      sessionId: 'voice-bad',
      probeMedia: async () => ({ status: 'failed', error: { code: 'media_probe_failed', message: 'bad media' } }),
    })).resolves.toMatchObject({
      status: 'ok', artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_probe_failed' } } } },
    })
  })

  it('fails recovery when media probing returns a non-positive duration', async () => {
    const { workspace, outputPath } = await prepareReadyRecovery('audio-zero-duration', 'voice-zero-duration')
    await fs.writeFile(outputPath, 'invalid duration audio')
    await saveRecoveredArtifact(workspace, 'audio-zero-duration', 'voice-zero-duration', outputPath)

    await expect(getIndexTTS2Task({
      projectId,
      sessionId: 'voice-zero-duration',
      probeMedia: async () => ({ status: 'ok', durationSeconds: 0 }),
    })).resolves.toMatchObject({
      status: 'ok', artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_probe_failed' } } } },
    })
  })

  it('fails recovery when artifact outputPath escapes the workspace audio artifact root', async () => {
    const { workspace } = await prepareReadyRecovery('audio-escape', 'voice-escape')
    const escapedPath = path.join(workspace.rootPath, 'escaped.wav')
    await fs.writeFile(escapedPath, 'outside audio artifacts')
    await saveRecoveredArtifact(workspace, 'audio-escape', 'voice-escape', escapedPath)
    const probeMedia = vi.fn(okMediaProbe)

    await expect(getIndexTTS2Task({ projectId, sessionId: 'voice-escape', probeMedia })).resolves.toMatchObject({
      status: 'ok', artifact: undefined,
      project: { stages: { voice: { status: 'failed', error: { code: 'audio_artifact_path_escape' } } } },
    })
    expect(probeMedia).not.toHaveBeenCalled()
  })
})

const okMediaProbe = async () => ({
  status: 'ok' as const,
  durationSeconds: 8,
})

const successfulAdapter: RunIndexTTS2Adapter = async (input) => {
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
  await fs.writeFile(input.outputPath, 'generated audio')
  return {
    status: 'ok',
    source: 'indextts2',
    outputPath: input.outputPath,
    durationSeconds: 8.5,
  }
}

function recoveredParameters() {
  return {
    scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2,
    useRandom: false, outputFormat: 'wav' as const,
  }
}

async function prepareReadyRecovery(artifactId: string, sessionId: string) {
  await saveApprovedScript('script-001')
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  await beginProjectStageOperation({
    projectId, stage: 'voice', operationId: artifactId, sessionId, source: 'indextts2',
    expectedUpstreamArtifactId: 'script-001',
  })
  await markProjectStageOperationRunning({ projectId, stage: 'voice', operationId: artifactId })
  await saveIndexTTS2TaskState({ workspace, sessionId, taskId: artifactId, artifactId, status: 'ready' })
  return { workspace, outputPath: path.join(workspace.artifactsPath, 'audio', `${artifactId}.wav`) }
}

async function saveRecoveredArtifact(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  artifactId: string,
  sessionId: string,
  outputPath: string,
) {
  await saveAudioArtifact({
    workspace, artifactId, sessionId, status: 'ready', source: 'indextts2', outputPath,
    durationSeconds: 8, parameters: recoveredParameters(),
  })
}

async function preparePersistenceInput(sessionId: string) {
  await saveApprovedScript('script-001')
  const { referenceRelativePath } = await saveReferenceAudioFiles()
  return {
    projectId,
    sessionId,
    parameters: {
      scriptArtifactId: 'script-001',
      text: '测试持久化失败窗口',
      referenceAudioPath: referenceRelativePath,
      speed: 1,
      emotionAlpha: 0.2,
      outputFormat: 'wav' as const,
      useRandom: false,
    },
    probeMedia: okMediaProbe,
    now: new Date().toISOString(),
  }
}

async function saveApprovedScript(artifactId: string) {
  await saveScript(artifactId, 'approved')
}

async function saveReferenceAudioFiles() {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const audioDir = path.join(workspace.filesPath, 'audio')
  await fs.mkdir(audioDir, { recursive: true })
  const referenceAbsolutePath = path.join(audioDir, 'reference.wav')
  const emotionAbsolutePath = path.join(audioDir, 'emotion.wav')
  await fs.writeFile(referenceAbsolutePath, 'reference audio')
  await fs.writeFile(emotionAbsolutePath, 'emotion audio')
  return {
    referenceRelativePath: 'files/audio/reference.wav',
    emotionRelativePath: 'files/audio/emotion.wav',
    referenceAbsolutePath,
    emotionAbsolutePath,
  }
}

async function saveScript(artifactId: string, approvalStatus: 'draft' | 'approved') {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  await saveScriptArtifact({
    workspace,
    artifactId,
    sessionId: 'script-session-001',
    approvalStatus,
    content: {
      title: '测试文案',
      hook: '测试开场',
      body: '今天测试 IndexTTS2 音频生成',
      caption: '测试 caption',
      tags: ['测试'],
      durationSeconds: 8,
      voiceNotes: '自然清晰',
      shotNotes: '正面口播',
      riskNotes: '无',
    },
    now: '2026-06-11T00:00:00.000Z',
  })
  await createProjectState({
    projectId,
    script: {
      ...emptyScript(),
      artifactId,
      approvalStatus,
      title: '测试文案',
      hook: '测试开场',
      body: '今天测试 IndexTTS2 音频生成',
      caption: '测试 caption',
      tags: ['测试'],
      generated: true,
    },
    now: '2026-06-11T00:00:00.000Z',
  })
}
