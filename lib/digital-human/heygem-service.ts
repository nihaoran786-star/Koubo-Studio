import fs from 'node:fs/promises'
import path from 'node:path'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { getRenderArtifact, saveRenderArtifact, type RenderArtifact } from '@/lib/artifacts/render-artifact'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { createAgentSessionMetadata } from '@/lib/agents/agent-session'
import { appendAgentSessionMetadata } from '@/lib/agents/agent-session-index'
import { probeMediaDuration, type ProbeMediaDuration } from '@/lib/media/media-probe'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  failProjectStageOperation,
  getProjectState,
  markProjectStageOperationRunning,
  ProjectStateError,
  reconcileProjectStageOperation,
} from '@/lib/project-state/project-state-service'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { getAvatarAsset, AvatarAssetValidationError } from './avatar-asset'
import { runHeyGemAdapter, type HeyGemRenderInput, type RunHeyGemAdapter } from './heygem-adapter'
import {
  HeyGemTaskStateError,
  readHeyGemTaskState,
  registerActiveHeyGemTask,
  saveHeyGemTaskState,
  type HeyGemTaskState,
} from './heygem-task'

export type GenerateHeyGemRenderResult =
  | { status: 'ok'; source: 'heygem_service'; artifact: RenderArtifact }
  | {
      status: 'invalid_request' | 'adapter_error'
      source: string
      artifact?: RenderArtifact
      error: { code: string; message: string }
    }

export interface HeyGemGenerateInput {
  avatarAssetId: string
  mode: HeyGemRenderInput['mode']
}

export type GetHeyGemTaskResult =
  | {
      status: 'ok'
      source: 'heygem_task'
      task?: HeyGemTaskState
      artifact?: RenderArtifact
      project: ProjectStateDocument
    }
  | {
      status: 'adapter_error'
      source: 'heygem_task'
      error: { code: string; message: string }
    }

export async function getHeyGemTask(input: {
  projectId: string
  sessionId: string
  now?: string
  recoveryWindowMs?: number
  probeMedia?: ProbeMediaDuration
  reconcileProjectStage?: typeof reconcileProjectStageOperation
}): Promise<GetHeyGemTaskResult> {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  let task: HeyGemTaskState | undefined
  try {
    task = await readHeyGemTaskState(workspace, sessionId, {
      now: input.now,
      recoveryWindowMs: input.recoveryWindowMs,
    })
  } catch (error) {
    if (error instanceof HeyGemTaskStateError) {
      return { status: 'adapter_error', source: 'heygem_task', error: { code: error.code, message: error.message } }
    }
    throw error
  }

  const persistedArtifact = task?.status === 'ready' && task.artifactId
    ? await getRenderArtifact(workspace, task.artifactId).catch(() => undefined)
    : undefined
  const readyValidation = task?.status === 'ready'
    ? await validateRecoveredRenderArtifact({
        workspace,
        sessionId,
        task,
        artifact: persistedArtifact,
        probeMedia: input.probeMedia ?? probeMediaDuration,
      })
    : undefined
  const validatedArtifact = readyValidation?.status === 'ok' ? readyValidation.artifact : undefined
  const taskObservation = !task
    ? { status: 'missing' as const, sessionId, source: 'heygem' as const }
    : task.status === 'ready'
      ? task.artifactId && readyValidation?.status === 'ok'
        ? {
            status: 'ready' as const,
            operationId: task.taskId,
            sessionId,
            source: 'heygem' as const,
            artifactId: task.artifactId,
          }
        : {
            status: 'failed' as const,
            operationId: task.taskId,
            sessionId,
            source: 'heygem' as const,
            error: readyValidation?.status === 'failed'
              ? readyValidation.error
              : { code: 'render_artifact_missing', message: '数字人任务已完成，但没有关联视频产物。' },
          }
      : task.status === 'failed'
        ? {
            status: 'failed' as const,
            operationId: task.taskId,
            sessionId,
            source: 'heygem' as const,
            error: task.error ?? { code: 'digital_human_generation_failed', message: '数字人生成失败。' },
          }
        : undefined
  const project = taskObservation
    ? await (input.reconcileProjectStage ?? reconcileProjectStageOperation)({
        projectId,
        stage: 'digitalHuman',
        task: taskObservation,
        now: input.now,
        missingTaskRecoveryWindowMs: input.recoveryWindowMs,
      })
    : await getProjectState(projectId)

  const artifact = validatedArtifact && task && renderArtifactMatchesCurrentProject({
    project,
    task,
    sessionId,
    artifact: validatedArtifact,
  })
    ? validatedArtifact
    : undefined

  return { status: 'ok', source: 'heygem_task', task, artifact, project }
}

function renderArtifactMatchesCurrentProject(input: {
  project: ProjectStateDocument
  task: HeyGemTaskState
  sessionId: string
  artifact: RenderArtifact
}) {
  const stage = input.project.stages.digitalHuman
  const operation = stage.operation
  return (
    input.task.status === 'ready' &&
    input.task.taskId === operation?.id &&
    input.task.artifactId === input.artifact.artifactId &&
    input.task.sessionId === input.sessionId &&
    input.artifact.sessionId === input.sessionId &&
    stage.status === 'ready' &&
    stage.source === 'heygem' &&
    stage.artifactId === input.artifact.artifactId &&
    operation?.sessionId === input.sessionId &&
    operation.upstreamArtifactId === input.artifact.audioArtifactId &&
    input.project.stages.voice.status === 'ready' &&
    input.project.stages.voice.artifactId === input.artifact.audioArtifactId &&
    input.project.stages.script.status === 'ready' &&
    input.project.stages.script.artifactId === input.artifact.scriptArtifactId
  )
}

type RecoveredRenderValidation =
  | { status: 'ok'; artifact: RenderArtifact }
  | { status: 'failed'; error: { code: string; message: string } }

async function validateRecoveredRenderArtifact(input: {
  workspace: ProjectWorkspace
  sessionId: string
  task: HeyGemTaskState
  artifact: RenderArtifact | undefined
  probeMedia: ProbeMediaDuration
}): Promise<RecoveredRenderValidation> {
  if (
    !input.artifact ||
    input.artifact.status !== 'ready' ||
    input.artifact.sessionId !== input.sessionId ||
    input.artifact.artifactId !== input.task.artifactId
  ) {
    return renderRecoveryFailure('render_artifact_missing', '数字人任务记录的视频产物不存在或关联无效。')
  }

  const renderRoot = resolveArtifactPath(input.workspace, 'render', '.')
  let outputPath: string
  try {
    outputPath = assertInsideRoot(renderRoot, input.artifact.outputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return renderRecoveryFailure('render_artifact_path_escape', '数字人视频路径越过了当前 workspace 的视频产物目录。')
    }
    throw error
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(outputPath)
  } catch {
    return renderRecoveryFailure('render_artifact_missing', '数字人视频文件不存在或无法读取。')
  }
  if (!stat.isFile()) return renderRecoveryFailure('render_artifact_missing', '数字人视频路径不是可读取的文件。')
  if (stat.size <= 0) return renderRecoveryFailure('render_artifact_empty', '数字人视频文件为空。')

  try {
    const [realRenderRoot, realOutputPath] = await Promise.all([fs.realpath(renderRoot), fs.realpath(outputPath)])
    assertInsideRoot(realRenderRoot, realOutputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return renderRecoveryFailure('render_artifact_path_escape', '数字人视频真实路径越过了当前 workspace 的视频产物目录。')
    }
    return renderRecoveryFailure('render_artifact_missing', '数字人视频文件不存在或无法读取。')
  }

  try {
    const probe = await input.probeMedia({ filePath: outputPath })
    if (probe.status !== 'ok' || !Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
      return renderRecoveryFailure('render_artifact_probe_failed', '数字人视频无法读出有效时长。')
    }
  } catch {
    return renderRecoveryFailure('render_artifact_probe_failed', '数字人视频无法通过媒体完整性检查。')
  }
  return { status: 'ok', artifact: input.artifact }
}

function renderRecoveryFailure(code: string, message: string): RecoveredRenderValidation {
  return { status: 'failed', error: { code, message } }
}

export async function generateHeyGemRender(input: {
  projectId: string
  sessionId: string
  input: HeyGemGenerateInput | unknown
  runAdapter?: RunHeyGemAdapter
  probeMedia?: ProbeMediaDuration
  saveTask?: typeof saveHeyGemTaskState
  saveArtifact?: typeof saveRenderArtifact
  appendSessionMetadata?: typeof appendAgentSessionMetadata
  beginProjectStage?: typeof beginProjectStageOperation
  markProjectStageRunning?: typeof markProjectStageOperationRunning
  completeProjectStage?: typeof completeProjectStageOperation
  failProjectStage?: typeof failProjectStageOperation
  createOperationId?: () => string
  now?: string
}): Promise<GenerateHeyGemRenderResult> {
  try {
    const projectId = assertSafeSegment(input.projectId, 'projectId')
    const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
    const generateInput = normalizeHeyGemGenerateInput(input.input)
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const project = await getProjectState(projectId).catch((error) => {
      if (error instanceof ProjectStateError && error.code === 'project_not_found') return undefined
      throw error
    })
    if (!project) return invalidRequest('project_not_found', '未找到当前创作项目，请先创建项目。')
    const scriptStage = project.stages.script
    const voiceStage = project.stages.voice
    if (scriptStage.status !== 'ready' || !scriptStage.artifactId) {
      return invalidRequest('script_not_ready', '请先完成并确认当前项目文案。')
    }
    if (voiceStage.status !== 'ready' || !voiceStage.artifactId) {
      return invalidRequest('audio_not_ready', '请先完成当前项目声音生成。')
    }
    const scriptArtifact = await getScriptArtifact(workspace, scriptStage.artifactId).catch(() => undefined)
    if (!scriptArtifact) return invalidRequest('missing_script_artifact', '未找到可用于数字人生成的文案 artifact。')
    if (scriptArtifact.approvalStatus !== 'approved') return invalidRequest('script_not_approved', '文案尚未确认，不能进入数字人生成。')
    const audioArtifact = await getAudioArtifact(workspace, voiceStage.artifactId).catch(() => undefined)
    if (!audioArtifact) return invalidRequest('missing_audio_artifact', '未找到可用于数字人生成的音频 artifact。')
    if (audioArtifact.status !== 'ready') return invalidRequest('audio_not_ready', '声音产物尚未就绪，不能进入数字人生成。')
    if (audioArtifact.parameters.scriptArtifactId !== scriptArtifact.artifactId) {
      return invalidRequest('audio_script_mismatch', '音频 artifact 与当前文案 artifact 不匹配，请重新生成音频。')
    }
    if (audioArtifact.parameters.scriptArtifactId !== scriptStage.artifactId) {
      return invalidRequest('audio_project_mismatch', '当前声音不属于当前项目文案，请重新生成声音。')
    }
    let avatarAsset
    try {
      avatarAsset = await getAvatarAsset(workspace, generateInput.avatarAssetId)
    } catch (error) {
      if (error instanceof AvatarAssetValidationError) return invalidRequest(error.code, error.message)
      throw error
    }
    if (!avatarAsset || avatarAsset.status !== 'ready') {
      return invalidRequest('missing_avatar_asset', '所选形象素材不存在或尚未就绪。')
    }
    const renderInput: HeyGemRenderInput = {
      scriptArtifactId: scriptArtifact.artifactId,
      audioArtifactId: audioArtifact.artifactId,
      avatar: {
        source: 'upload',
        id: avatarAsset.assetId,
        name: avatarAsset.originalFilename,
        assetPath: avatarAsset.path,
      },
      mode: generateInput.mode,
    }
    const avatarValidation = await validateAvatarAsset(
      workspace.rootPath,
      workspace.filesPath,
      renderInput,
      input.probeMedia ?? probeMediaDuration,
    )
    if (avatarValidation) return avatarValidation

    const artifactId = assertSafeSegment(
      input.createOperationId?.() ?? `render-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      'operationId',
    )
    const outputPath = resolveArtifactPath(workspace, 'render', `${artifactId}.mp4`)
    const saveTask = input.saveTask ?? saveHeyGemTaskState
    const saveArtifact = input.saveArtifact ?? saveRenderArtifact
    const appendSessionMetadata = input.appendSessionMetadata ?? appendAgentSessionMetadata
    const beginProjectStage = input.beginProjectStage ?? beginProjectStageOperation
    const markProjectStageRunning = input.markProjectStageRunning ?? markProjectStageOperationRunning
    const completeProjectStage = input.completeProjectStage ?? completeProjectStageOperation
    const failProjectStage = input.failProjectStage ?? failProjectStageOperation

    try {
      await beginProjectStage({
        projectId,
        stage: 'digitalHuman',
        operationId: artifactId,
        sessionId,
        source: 'heygem',
        expectedUpstreamArtifactId: audioArtifact.artifactId,
        now: input.now,
      })
    } catch (error) {
      return persistenceFailure('project_stage_begin_failed', '数字人任务无法写入项目状态，尚未启动数字人生成。', error)
    }

    const settleProjectFailure = async (failure: FailedHeyGemResult) => {
      await bestEffortFailProjectStage({ failProjectStage, projectId, operationId: artifactId, error: failure.error, now: input.now })
      return failure
    }
    const unregisterActiveTask = registerActiveHeyGemTask(workspace, sessionId, artifactId)
    let queuedTask: HeyGemTaskState | undefined
    try {
      try {
        queuedTask = await saveTask({ workspace, sessionId, taskId: artifactId, artifactId, status: 'queued', now: input.now })
      } catch (error) {
        return await settleProjectFailure(persistenceFailure('task_persist_failed', '数字人任务无法保存，尚未启动生成。', error))
      }

      try {
        await markProjectStageRunning({ projectId, stage: 'digitalHuman', operationId: artifactId, now: input.now })
      } catch (error) {
        const failure = persistenceFailure('project_stage_running_failed', '数字人任务无法进入项目运行状态，尚未调用运行时。', error)
        await bestEffortFailTask({ saveTask, workspace, sessionId, artifactId, createdAt: queuedTask.createdAt, error: failure.error, now: input.now })
        return await settleProjectFailure(failure)
      }

      try {
        await saveTask({ workspace, sessionId, taskId: artifactId, artifactId, status: 'running', createdAt: queuedTask.createdAt, now: input.now })
      } catch (error) {
        const failure = persistenceFailure('task_persist_failed', '数字人任务无法进入运行状态，尚未启动生成。', error)
        await bestEffortFailTask({ saveTask, workspace, sessionId, artifactId, createdAt: queuedTask.createdAt, error: failure.error, now: input.now })
        return await settleProjectFailure(failure)
      }

      let adapterResult
      try {
        adapterResult = await (input.runAdapter ?? runHeyGemAdapter)({
          projectId,
          workspacePath: workspace.rootPath,
          scriptArtifact,
          audioArtifact,
          input: renderInput,
          outputPath,
        })
      } catch (error) {
        adapterResult = {
          status: 'adapter_error' as const,
          source: 'heygem' as const,
          error: { code: 'runtime_failed', message: error instanceof Error ? error.message : String(error) },
        }
      }

      if (adapterResult.status !== 'ok') {
        let failedArtifact: RenderArtifact
        try {
          failedArtifact = (await saveArtifact({
            workspace,
            artifactId,
            sessionId,
            status: 'failed',
            source: 'heygem',
            scriptArtifactId: scriptArtifact.artifactId,
            audioArtifactId: audioArtifact.artifactId,
            outputPath: path.normalize(outputPath),
            durationSeconds: 0,
            avatar: renderInput.avatar,
            mode: renderInput.mode,
            error: adapterResult.error,
            now: input.now,
          })).artifact
        } catch (error) {
          const failure = persistenceFailure('artifact_persist_failed', '数字人生成失败，且失败产物无法保存。', error)
          return await settleProjectFailure(await terminalizeFailure(failure, saveTask, workspace, sessionId, artifactId, queuedTask.createdAt, input.now))
        }
        try {
          await appendDigitalHumanSession(appendSessionMetadata, workspace, sessionId, failedArtifact.artifactId)
        } catch (error) {
          const failure = persistenceFailure('artifact_persist_failed', '数字人失败产物已保存，但创作会话无法关联。', error)
          return await settleProjectFailure(await terminalizeFailure(failure, saveTask, workspace, sessionId, artifactId, queuedTask.createdAt, input.now))
        }
        try {
          await saveTask({ workspace, sessionId, taskId: artifactId, artifactId, status: 'failed', error: adapterResult.error, createdAt: queuedTask.createdAt, now: input.now })
        } catch (error) {
          return await settleProjectFailure(persistenceFailure(
            'task_persist_failed',
            `数字人生成失败（${adapterResult.error.code}：${adapterResult.error.message}），且失败状态无法保存。`,
            error,
          ))
        }
        const settled = await settleProjectFailure({ ...adapterResult, artifact: failedArtifact })
        return settled
      }

      let artifact: RenderArtifact
      try {
        artifact = (await saveArtifact({
          workspace,
          artifactId,
          sessionId,
          status: 'ready',
          source: 'heygem',
          scriptArtifactId: scriptArtifact.artifactId,
          audioArtifactId: audioArtifact.artifactId,
          outputPath: path.normalize(adapterResult.outputPath),
          durationSeconds: adapterResult.durationSeconds,
          avatar: renderInput.avatar,
          mode: renderInput.mode,
          now: input.now,
        })).artifact
      } catch (error) {
        const failure = persistenceFailure('artifact_persist_failed', '数字人视频已生成，但产物无法保存。', error)
        return await settleProjectFailure(await terminalizeFailure(failure, saveTask, workspace, sessionId, artifactId, queuedTask.createdAt, input.now))
      }
      try {
        await appendDigitalHumanSession(appendSessionMetadata, workspace, sessionId, artifact.artifactId)
      } catch (error) {
        const failure = persistenceFailure('artifact_persist_failed', '数字人视频已保存，但创作会话无法关联该产物。', error)
        return await settleProjectFailure(await terminalizeFailure(failure, saveTask, workspace, sessionId, artifactId, queuedTask.createdAt, input.now))
      }
      try {
        await saveTask({ workspace, sessionId, taskId: artifactId, artifactId: artifact.artifactId, status: 'ready', createdAt: queuedTask.createdAt, now: input.now })
      } catch (error) {
        const failure = persistenceFailure('task_persist_failed', '数字人视频已生成，但任务完成状态无法保存。', error)
        return await settleProjectFailure(await terminalizeFailure(failure, saveTask, workspace, sessionId, artifactId, queuedTask.createdAt, input.now))
      }
      try {
        await completeProjectStage({ projectId, stage: 'digitalHuman', operationId: artifactId, artifactId: artifact.artifactId, now: input.now })
      } catch (error) {
        return await settleProjectFailure(persistenceFailure('project_stage_complete_failed', '数字人视频已生成，但项目状态无法关联该产物。', error))
      }
      return { status: 'ok', source: 'heygem_service', artifact }
    } catch (error) {
      const failure = persistenceFailure('digital_human_generation_failed', '数字人生成流程异常中断。', error)
      if (queuedTask) await bestEffortFailTask({ saveTask, workspace, sessionId, artifactId, createdAt: queuedTask.createdAt, error: failure.error, now: input.now })
      return await settleProjectFailure(failure)
    } finally {
      unregisterActiveTask()
    }
  } catch (error) {
    if (error instanceof HeyGemInputValidationError) return invalidRequest(error.code, error.message)
    throw error
  }
}

type FailedHeyGemResult = Exclude<GenerateHeyGemRenderResult, { status: 'ok' }>
type SaveHeyGemTask = typeof saveHeyGemTaskState

async function appendDigitalHumanSession(
  appendSessionMetadata: typeof appendAgentSessionMetadata,
  workspace: ProjectWorkspace,
  sessionId: string,
  artifactId: string,
) {
  await appendSessionMetadata(workspace, createAgentSessionMetadata({
    sessionId,
    sessionKind: 'main',
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.rootPath,
    agentRole: 'digital_human',
    artifactId,
  }))
}

async function terminalizeFailure(
  failure: FailedHeyGemResult,
  saveTask: SaveHeyGemTask,
  workspace: ProjectWorkspace,
  sessionId: string,
  artifactId: string,
  createdAt: string,
  now?: string,
) {
  const terminal = await bestEffortFailTask({ saveTask, workspace, sessionId, artifactId, createdAt, error: failure.error, now })
  return terminal.status === 'ok'
    ? failure
    : persistenceFailure('task_persist_failed', `${failure.error.message} 同时任务失败状态无法保存。`, terminal.error)
}

async function bestEffortFailTask(input: {
  saveTask: SaveHeyGemTask
  workspace: ProjectWorkspace
  sessionId: string
  artifactId: string
  createdAt: string
  error: { code: string; message: string }
  now?: string
}) {
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
    return { status: 'ok' as const }
  } catch (error) {
    return { status: 'failed' as const, error }
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
      stage: 'digitalHuman',
      operationId: input.operationId,
      error: input.error,
      now: input.now,
    })
  } catch {
    // A stale operation must never overwrite a newer project stage.
  }
}

function persistenceFailure(code: string, message: string, error: unknown): FailedHeyGemResult {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    status: 'adapter_error',
    source: 'heygem_service',
    error: { code, message: detail ? `${message} 原因：${detail}` : message },
  }
}

class HeyGemInputValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'HeyGemInputValidationError'
  }
}

function normalizeHeyGemGenerateInput(input: HeyGemGenerateInput | unknown): HeyGemGenerateInput {
  if (!isRecord(input)) throw new HeyGemInputValidationError('invalid_input', '数字人生成参数格式无效。')
  if ('scriptArtifactId' in input || 'audioArtifactId' in input || 'avatar' in input) {
    throw new HeyGemInputValidationError(
      'client_lineage_forbidden',
      '数字人生成只能选择当前项目的形象素材，文案、声音和文件路径由应用自动解析。',
    )
  }
  const avatarAssetId = readRequiredString(input, 'avatarAssetId')
  if (input.mode !== 'fast' && input.mode !== 'standard' && input.mode !== 'cinema') {
    throw new HeyGemInputValidationError('invalid_mode', '数字人生成模式无效。')
  }
  return { avatarAssetId: assertSafeSegment(avatarAssetId, 'avatarAssetId'), mode: input.mode }
}

function readRequiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) {
    const code = key === 'avatarAssetId' ? 'invalid_avatar_asset_id' : `invalid_${key}`
    throw new HeyGemInputValidationError(code, `${key} 不能为空。`)
  }
  return value.trim()
}

function invalidRequest(code: string, message: string): GenerateHeyGemRenderResult {
  return { status: 'invalid_request', source: 'heygem_service', error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function validateAvatarAsset(
  workspaceRootPath: string,
  workspaceFilesPath: string,
  input: HeyGemRenderInput,
  probeMedia: ProbeMediaDuration,
): Promise<GenerateHeyGemRenderResult | undefined> {
  if (input.avatar.source !== 'upload') return undefined
  if (!input.avatar.assetPath) return invalidRequest('missing_avatar_asset', '上传形象必须先进入当前项目 workspace 文件目录。')
  try {
    const candidate = path.isAbsolute(input.avatar.assetPath) ? input.avatar.assetPath : path.join(workspaceRootPath, input.avatar.assetPath)
    const safePath = assertInsideRoot(workspaceFilesPath, candidate)
    const stat = await fs.stat(safePath)
    if (!stat.isFile() || stat.size <= 0) return invalidRequest('avatar_asset_missing', '上传形象素材不存在或为空，请重新上传。')
    const [realFilesRoot, realAssetPath] = await Promise.all([
      fs.realpath(workspaceFilesPath),
      fs.realpath(safePath),
    ])
    assertInsideRoot(realFilesRoot, realAssetPath)
    const probeResult = await probeMedia({ filePath: safePath })
    if (probeResult.status !== 'ok') return invalidRequest('avatar_asset_probe_failed', `上传形象视频无法读取有效时长：${probeResult.error.message}`)
    input.avatar.assetPath = safePath
    return undefined
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return invalidRequest('avatar_asset_path_escape', '上传形象路径越过了当前 workspace files 目录。')
    if (isMissingPathError(error)) return invalidRequest('avatar_asset_missing', '上传形象素材不存在或为空，请重新上传。')
    throw error
  }
}

function isMissingPathError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
