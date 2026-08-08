import fs from 'node:fs/promises'
import path from 'node:path'
import { getAudioArtifact, saveAudioArtifact, type AudioArtifact } from '@/lib/artifacts/audio-artifact'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { appendAgentSessionMetadata } from '@/lib/agents/agent-session-index'
import { createAgentSessionMetadata } from '@/lib/agents/agent-session'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { probeMediaDuration, type ProbeMediaDuration } from '@/lib/media/media-probe'
import { runIndexTTS2Adapter, type RunIndexTTS2Adapter } from './indextts2-adapter'
import {
  IndexTTS2TaskStateError,
  readIndexTTS2TaskState,
  registerActiveIndexTTS2Task,
  saveIndexTTS2TaskState,
  type IndexTTS2TaskState,
} from './indextts2-task'
import {
  normalizeVoiceGenerationParameters,
  VoiceGenerationValidationError,
  type VoiceGenerationParameters,
} from './voice-generation'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  failProjectStageOperation,
  getProjectState,
  markProjectStageOperationRunning,
  reconcileProjectStageOperation,
} from '@/lib/project-state/project-state-service'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'

const MIN_REFERENCE_AUDIO_SECONDS = 8
const MAX_REFERENCE_AUDIO_SECONDS = 12

export type GenerateIndexTTS2AudioResult =
  | {
      status: 'ok'
      source: 'indextts2_service'
      artifact: AudioArtifact
    }
  | {
      status: 'invalid_request' | 'adapter_error'
      source: string
      error: {
        code: string
        message: string
      }
    }

export type GetIndexTTS2TaskResult =
  | {
      status: 'ok'
      source: 'indextts2_task'
      task?: IndexTTS2TaskState
      artifact?: AudioArtifact
      project: ProjectStateDocument
    }
  | {
      status: 'adapter_error'
      source: 'indextts2_task'
      error: {
        code: string
        message: string
      }
    }

export async function getIndexTTS2Task(input: {
  projectId: string
  sessionId: string
  now?: string
  recoveryWindowMs?: number
  probeMedia?: ProbeMediaDuration
  reconcileProjectStage?: typeof reconcileProjectStageOperation
}): Promise<GetIndexTTS2TaskResult> {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  let task: IndexTTS2TaskState | undefined
  try {
    task = await readIndexTTS2TaskState(workspace, sessionId, {
      now: input.now,
      recoveryWindowMs: input.recoveryWindowMs,
    })
  } catch (error) {
    if (error instanceof IndexTTS2TaskStateError) {
      return {
        status: 'adapter_error',
        source: 'indextts2_task',
        error: { code: error.code, message: error.message },
      }
    }
    throw error
  }
  const persistedArtifact = task?.status === 'ready' && task.artifactId
    ? await getAudioArtifact(workspace, task.artifactId).catch(() => undefined)
    : undefined
  const readyArtifactValidation = task?.status === 'ready'
    ? await validateRecoveredAudioArtifact({
        workspace,
        artifact: persistedArtifact,
        probeMedia: input.probeMedia ?? probeMediaDuration,
      })
    : undefined
  const artifact = readyArtifactValidation?.status === 'ok'
    ? readyArtifactValidation.artifact
    : undefined
  const taskObservation = !task
    ? { status: 'missing' as const, sessionId, source: 'indextts2' as const }
    : task.status === 'ready'
      ? task.artifactId && readyArtifactValidation?.status === 'ok'
        ? {
            status: 'ready' as const,
            operationId: task.taskId,
            sessionId,
            source: 'indextts2' as const,
            artifactId: task.artifactId,
          }
        : {
            status: 'failed' as const,
            operationId: task.taskId,
            sessionId,
            source: 'indextts2' as const,
            error: readyArtifactValidation?.status === 'failed'
              ? readyArtifactValidation.error
              : { code: 'audio_artifact_missing', message: '声音任务已完成，但没有关联音频产物。' },
          }
      : task.status === 'failed'
        ? {
            status: 'failed' as const,
            operationId: task.taskId,
            sessionId,
            source: 'indextts2' as const,
            error: task.error ?? { code: 'voice_generation_failed', message: '声音生成失败。' },
          }
        : undefined
  const project = taskObservation
    ? await (input.reconcileProjectStage ?? reconcileProjectStageOperation)({
        projectId,
        stage: 'voice',
        task: taskObservation,
        now: input.now,
        missingTaskRecoveryWindowMs: input.recoveryWindowMs,
      })
    : await getProjectState(projectId)
  return {
    status: 'ok',
    source: 'indextts2_task',
    task,
    artifact,
    project,
  }
}

type RecoveredAudioArtifactValidation =
  | { status: 'ok'; artifact: AudioArtifact }
  | { status: 'failed'; error: { code: string; message: string } }

async function validateRecoveredAudioArtifact(input: {
  workspace: ProjectWorkspace
  artifact: AudioArtifact | undefined
  probeMedia: ProbeMediaDuration
}): Promise<RecoveredAudioArtifactValidation> {
  if (!input.artifact || input.artifact.status !== 'ready') {
    return recoveredAudioFailure('audio_artifact_missing', '声音任务记录的音频产物不存在。')
  }

  const audioRoot = resolveArtifactPath(input.workspace, 'audio', '.')
  let outputPath: string
  try {
    outputPath = assertInsideRoot(audioRoot, input.artifact.outputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return recoveredAudioFailure('audio_artifact_path_escape', '声音产物路径越过了当前 workspace 的音频产物目录。')
    }
    throw error
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(outputPath)
  } catch {
    return recoveredAudioFailure('audio_artifact_missing', '声音产物文件不存在或无法读取。')
  }
  if (!stat.isFile()) {
    return recoveredAudioFailure('audio_artifact_missing', '声音产物路径不是可读取的文件。')
  }
  if (stat.size <= 0) {
    return recoveredAudioFailure('audio_artifact_empty', '声音产物文件为空。')
  }

  try {
    const [realAudioRoot, realOutputPath] = await Promise.all([
      fs.realpath(audioRoot),
      fs.realpath(outputPath),
    ])
    assertInsideRoot(realAudioRoot, realOutputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return recoveredAudioFailure('audio_artifact_path_escape', '声音产物真实路径越过了当前 workspace 的音频产物目录。')
    }
    return recoveredAudioFailure('audio_artifact_missing', '声音产物文件不存在或无法读取。')
  }

  let probeResult: Awaited<ReturnType<ProbeMediaDuration>>
  try {
    probeResult = await input.probeMedia({ filePath: outputPath })
  } catch {
    return recoveredAudioFailure('audio_artifact_probe_failed', '声音产物无法通过媒体完整性检查。')
  }
  if (probeResult.status !== 'ok' || !Number.isFinite(probeResult.durationSeconds) || probeResult.durationSeconds <= 0) {
    return recoveredAudioFailure('audio_artifact_probe_failed', '声音产物无法读出有效时长。')
  }
  return { status: 'ok', artifact: input.artifact }
}

function recoveredAudioFailure(code: string, message: string): RecoveredAudioArtifactValidation {
  return { status: 'failed', error: { code, message } }
}

export async function generateIndexTTS2Audio(input: {
  projectId: string
  sessionId: string
  parameters: VoiceGenerationParameters | unknown
  runAdapter?: RunIndexTTS2Adapter
  probeMedia?: ProbeMediaDuration
  saveTask?: typeof saveIndexTTS2TaskState
  saveArtifact?: typeof saveAudioArtifact
  appendSessionMetadata?: typeof appendAgentSessionMetadata
  beginProjectStage?: typeof beginProjectStageOperation
  markProjectStageRunning?: typeof markProjectStageOperationRunning
  completeProjectStage?: typeof completeProjectStageOperation
  failProjectStage?: typeof failProjectStageOperation
  createOperationId?: () => string
  now?: string
}): Promise<GenerateIndexTTS2AudioResult> {
  try {
    const projectId = assertSafeSegment(input.projectId, 'projectId')
    const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
    const parameters = normalizeVoiceGenerationParameters(input.parameters)
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    if (!parameters.scriptArtifactId) {
      return invalidRequest('script_artifact_missing', '请先在文案页生成并确认文案。')
    }
    const scriptArtifactId = assertSafeSegment(parameters.scriptArtifactId, 'scriptArtifactId')
    const scriptArtifact = await getScriptArtifact(workspace, scriptArtifactId).catch(() => undefined)

    if (!scriptArtifact) {
      return invalidRequest('script_artifact_missing', '请先在文案页生成并确认文案。')
    }

    if (scriptArtifact.approvalStatus !== 'approved') {
      return invalidRequest('script_not_approved', '文案尚未确认，不能进入音频生成。')
    }
    const trustedScriptText = scriptArtifact.content.body.trim()
    if (!trustedScriptText) {
      return invalidRequest('script_text_missing', '已确认文案缺少正文，不能进入音频生成。')
    }
    const trustedParameters = {
      ...parameters,
      text: trustedScriptText,
    }

    if (trustedParameters.referenceAudioPath?.startsWith('preset:')) {
      return invalidRequest('reference_audio_not_ready', '预设音色还没有绑定真实参考音频文件。请先上传 8-12 秒声音参考音频后再生成。')
    }
    if (!trustedParameters.referenceAudioPath) {
      return invalidRequest('reference_audio_missing', '请先上传 8-12 秒声音参考音频后再生成。')
    }

    const adapterParameters = await resolveAdapterReferencePaths(trustedParameters, workspace.rootPath)
    const mediaValidation = await validateReferenceAudioInputs(adapterParameters, input.probeMedia ?? probeMediaDuration)
    if (mediaValidation) return mediaValidation

    const artifactId = assertSafeSegment(
      input.createOperationId?.() ?? `audio-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      'operationId',
    )
    const outputPath = resolveArtifactPath(workspace, 'audio', `${artifactId}.${trustedParameters.outputFormat}`)
    const saveTask = input.saveTask ?? saveIndexTTS2TaskState
    const saveArtifact = input.saveArtifact ?? saveAudioArtifact
    const appendSessionMetadata = input.appendSessionMetadata ?? appendAgentSessionMetadata
    const beginProjectStage = input.beginProjectStage ?? beginProjectStageOperation
    const markProjectStageRunning = input.markProjectStageRunning ?? markProjectStageOperationRunning
    const completeProjectStage = input.completeProjectStage ?? completeProjectStageOperation
    const failProjectStage = input.failProjectStage ?? failProjectStageOperation

    try {
      await beginProjectStage({
        projectId,
        stage: 'voice',
        operationId: artifactId,
        sessionId,
        source: 'indextts2',
        expectedUpstreamArtifactId: scriptArtifactId,
        now: input.now,
      })
    } catch (error) {
      return projectStageFailure('project_stage_begin_failed', '声音任务无法写入项目状态，尚未启动声音生成。', error)
    }

    const settleProjectFailure = async (failure: Exclude<GenerateIndexTTS2AudioResult, { status: 'ok' }>) => {
      await bestEffortFailProjectStage({
        failProjectStage,
        projectId,
        operationId: artifactId,
        error: failure.error,
        now: input.now,
      })
      return failure
    }
    const unregisterActiveTask = registerActiveIndexTTS2Task(workspace, sessionId, artifactId)
    try {
      let queuedTask: IndexTTS2TaskState
      try {
        queuedTask = await saveTask({
          workspace,
          sessionId,
          taskId: artifactId,
          artifactId,
          status: 'queued',
          now: input.now,
        })
      } catch (error) {
        return await settleProjectFailure(taskPersistFailed('声音任务无法保存，尚未启动声音生成。', error))
      }

      try {
        await markProjectStageRunning({
          projectId,
          stage: 'voice',
          operationId: artifactId,
          now: input.now,
        })
      } catch (error) {
        const failure = projectStageFailure('project_stage_running_failed', '声音任务无法进入项目运行状态，尚未调用声音运行时。', error)
        await bestEffortFailTask({
          saveTask,
          workspace,
          sessionId,
          artifactId,
          createdAt: queuedTask.createdAt,
          error: failure.error,
          now: input.now,
        })
        return await settleProjectFailure(failure)
      }

      try {
        await saveTask({
          workspace,
          sessionId,
          taskId: artifactId,
          artifactId,
          status: 'running',
          createdAt: queuedTask.createdAt,
          now: input.now,
        })
      } catch (error) {
        const failure = taskPersistFailed('声音任务无法进入运行状态，尚未启动声音生成。', error)
        await bestEffortFailTask({
          saveTask,
          workspace,
          sessionId,
          artifactId,
          createdAt: queuedTask.createdAt,
          error: failure.error,
          now: input.now,
        })
        return await settleProjectFailure(failure)
      }

      let adapterResult
      try {
        adapterResult = await (input.runAdapter ?? runIndexTTS2Adapter)({
          projectId,
          workspacePath: workspace.rootPath,
          parameters: adapterParameters,
          outputPath,
        })
      } catch (error) {
        adapterResult = {
          status: 'adapter_error' as const,
          source: 'indextts2' as const,
          error: {
            code: 'runtime_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }

      if (adapterResult.status !== 'ok') {
        try {
          await saveTask({
            workspace,
            sessionId,
            taskId: artifactId,
            artifactId,
            status: 'failed',
            error: adapterResult.error,
            createdAt: queuedTask.createdAt,
            now: input.now,
          })
          return await settleProjectFailure(adapterResult)
        } catch (error) {
          return await settleProjectFailure(taskPersistFailed(
            `声音生成失败（${adapterResult.error.code}：${adapterResult.error.message}），且失败状态无法保存。`,
            error,
          ))
        }
      }

      let artifact: AudioArtifact
      try {
        const saved = await saveArtifact({
          workspace,
          artifactId,
          sessionId,
          status: 'ready',
          source: 'indextts2',
          outputPath: path.normalize(adapterResult.outputPath),
          durationSeconds: adapterResult.durationSeconds,
          parameters: trustedParameters,
          now: input.now,
        })
        artifact = saved.artifact
      } catch (error) {
        const failure = artifactPersistFailed('声音已生成，但音频产物无法保存。', error)
        return await settleProjectFailure(await settlePersistenceFailure({
          failure,
          saveTask,
          workspace,
          sessionId,
          artifactId,
          createdAt: queuedTask.createdAt,
          now: input.now,
        }))
      }

      try {
        await appendSessionMetadata(
          workspace,
          createAgentSessionMetadata({
            sessionId,
            sessionKind: 'main',
            workspaceId: workspace.workspaceId,
            workspacePath: workspace.rootPath,
            agentRole: 'voice',
            artifactId: artifact.artifactId,
          }),
        )
      } catch (error) {
        const failure = artifactPersistFailed('音频已保存，但创作会话无法关联该产物。', error)
        return await settleProjectFailure(await settlePersistenceFailure({
          failure,
          saveTask,
          workspace,
          sessionId,
          artifactId,
          createdAt: queuedTask.createdAt,
          now: input.now,
        }))
      }

      try {
        await saveTask({
          workspace,
          sessionId,
          taskId: artifactId,
          artifactId: artifact.artifactId,
          status: 'ready',
          createdAt: queuedTask.createdAt,
          now: input.now,
        })
      } catch (error) {
        const failure = taskPersistFailed('声音已生成，但任务完成状态无法保存。', error)
        return await settleProjectFailure(await settlePersistenceFailure({
          failure,
          saveTask,
          workspace,
          sessionId,
          artifactId,
          createdAt: queuedTask.createdAt,
          now: input.now,
        }))
      }

      try {
        await completeProjectStage({
          projectId,
          stage: 'voice',
          operationId: artifactId,
          artifactId: artifact.artifactId,
          now: input.now,
        })
      } catch (error) {
        return await settleProjectFailure(projectStageFailure(
          'project_stage_complete_failed',
          '声音已生成，但项目状态无法关联该音频产物。',
          error,
        ))
      }

      return {
        status: 'ok',
        source: 'indextts2_service',
        artifact,
      }
    } catch (error) {
      return await settleProjectFailure(projectStageFailure(
        'voice_generation_failed',
        '声音生成流程异常中断。',
        error,
      ))
    } finally {
      unregisterActiveTask()
    }
  } catch (error) {
    if (error instanceof ReferencePathResolutionError) {
      return invalidRequest(error.code, error.message)
    }
    if (error instanceof VoiceGenerationValidationError) {
      return {
        status: 'invalid_request',
        source: error.source,
        error: {
          code: error.code,
          message: error.message,
        },
      }
    }
    throw error
  }
}

function invalidRequest(code: string, message: string): GenerateIndexTTS2AudioResult {
  return {
    status: 'invalid_request',
    source: 'indextts2_service',
    error: {
      code,
      message,
    },
  }
}

type PersistenceFailureResult = {
  status: 'adapter_error'
  source: 'indextts2_service'
  error: {
    code: string
    message: string
  }
}
type SaveIndexTTS2Task = typeof saveIndexTTS2TaskState

function taskPersistFailed(message: string, error: unknown): PersistenceFailureResult {
  return persistenceFailure('task_persist_failed', message, error)
}

function artifactPersistFailed(message: string, error: unknown): PersistenceFailureResult {
  return persistenceFailure('artifact_persist_failed', message, error)
}

function projectStageFailure(code: string, message: string, error: unknown): PersistenceFailureResult {
  return persistenceFailure(code, message, error)
}

function persistenceFailure(code: string, message: string, error: unknown): PersistenceFailureResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    status: 'adapter_error',
    source: 'indextts2_service',
    error: {
      code,
      message: detail ? `${message} 原因：${detail}` : message,
    },
  }
}

async function settlePersistenceFailure(input: {
  failure: PersistenceFailureResult
  saveTask: SaveIndexTTS2Task
  workspace: ProjectWorkspace
  sessionId: string
  artifactId: string
  createdAt: string
  now?: string
}): Promise<PersistenceFailureResult> {
  const terminal = await bestEffortFailTask({
    ...input,
    error: input.failure.error,
  })
  if (terminal.status === 'ok') return input.failure
  return taskPersistFailed(
    `${input.failure.error.message} 同时任务失败状态无法保存。`,
    terminal.error,
  )
}

async function bestEffortFailTask(input: {
  saveTask: SaveIndexTTS2Task
  workspace: ProjectWorkspace
  sessionId: string
  artifactId: string
  createdAt: string
  error: { code: string; message: string }
  now?: string
}): Promise<{ status: 'ok' } | { status: 'failed'; error: unknown }> {
  try {
    await input.saveTask({
      workspace: input.workspace,
      sessionId: input.sessionId,
      taskId: input.artifactId,
      artifactId: input.artifactId,
      status: 'failed',
      error: input.error,
      createdAt: input.createdAt,
      now: input.now,
    })
    return { status: 'ok' }
  } catch (error) {
    return { status: 'failed', error }
  }
}

async function bestEffortFailProjectStage(input: {
  failProjectStage: typeof failProjectStageOperation
  projectId: string
  operationId: string
  error: { code: string; message: string }
  now?: string
}) {
  try {
    await input.failProjectStage({
      projectId: input.projectId,
      stage: 'voice',
      operationId: input.operationId,
      error: input.error,
      now: input.now,
    })
  } catch {
    // The original failure remains authoritative. A stale operation must never
    // be allowed to overwrite a newer project stage while settling.
  }
}

async function validateReferenceAudioInputs(
  parameters: VoiceGenerationParameters,
  probeMedia: ProbeMediaDuration,
): Promise<GenerateIndexTTS2AudioResult | undefined> {
  const referenceAudioPath = parameters.referenceAudioPath
  if (!referenceAudioPath) {
    return invalidRequest('reference_audio_missing', '请先上传 8-12 秒声音参考音频后再生成。')
  }
  const referenceResult = await probeMedia({ filePath: referenceAudioPath })
  if (referenceResult.status !== 'ok') {
    return invalidRequest('reference_audio_probe_failed', `声音参考音频无法读取有效时长：${referenceResult.error.message}`)
  }
  if (
    referenceResult.durationSeconds < MIN_REFERENCE_AUDIO_SECONDS ||
    referenceResult.durationSeconds > MAX_REFERENCE_AUDIO_SECONDS
  ) {
    return invalidRequest(
      'reference_audio_duration_out_of_range',
      `声音参考音频需为 ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} 秒，当前约 ${referenceResult.durationSeconds.toFixed(1)} 秒。`,
    )
  }
  if (parameters.emotionReferenceAudioPath) {
    const emotionResult = await probeMedia({ filePath: parameters.emotionReferenceAudioPath })
    if (emotionResult.status !== 'ok') {
      return invalidRequest('emotion_reference_audio_probe_failed', `情绪参考音频无法读取有效时长：${emotionResult.error.message}`)
    }
    if (
      emotionResult.durationSeconds < MIN_REFERENCE_AUDIO_SECONDS ||
      emotionResult.durationSeconds > MAX_REFERENCE_AUDIO_SECONDS
    ) {
      return invalidRequest(
        'emotion_reference_audio_duration_out_of_range',
        `情绪参考音频需为 ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} 秒，当前约 ${emotionResult.durationSeconds.toFixed(1)} 秒。`,
      )
    }
  }
  return undefined
}

async function resolveAdapterReferencePaths(
  parameters: VoiceGenerationParameters,
  workspaceRoot: string,
): Promise<VoiceGenerationParameters> {
  return {
    ...parameters,
    referenceAudioPath: await resolveReferencePath({
      value: parameters.referenceAudioPath,
      workspaceRoot,
      code: 'reference_audio_missing',
      label: '声音参考音频',
    }),
    emotionReferenceAudioPath: parameters.emotionReferenceAudioPath
      ? await resolveReferencePath({
          value: parameters.emotionReferenceAudioPath,
          workspaceRoot,
          code: 'emotion_reference_audio_missing',
          label: '情绪参考音频',
        })
      : undefined,
  }
}

async function resolveReferencePath(input: {
  value: string | undefined
  workspaceRoot: string
  code: string
  label: string
}) {
  if (!input.value) {
    throw new ReferencePathResolutionError(input.code, `${input.label}不能为空`)
  }
  try {
    const target = path.isAbsolute(input.value)
      ? assertInsideRoot(input.workspaceRoot, input.value)
      : assertInsideRoot(input.workspaceRoot, path.join(input.workspaceRoot, input.value))
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size <= 0) {
      throw new ReferencePathResolutionError(input.code, `${input.label}不存在或为空`)
    }
    return target
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new ReferencePathResolutionError('reference_audio_path_escape', `${input.label}必须位于当前 workspace 内`)
    }
    if (error instanceof ReferencePathResolutionError) throw error
    throw new ReferencePathResolutionError(input.code, `${input.label}不存在或为空`)
  }
}

class ReferencePathResolutionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ReferencePathResolutionError'
  }
}
