import fs from 'node:fs/promises'
import path from 'node:path'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import {
  getPostProductionArtifact,
  savePostProductionArtifact,
  type PostProductionArtifact,
  type PostProductionParameters,
  type PostProductionSkillCall,
} from '@/lib/artifacts/post-production-artifact'
import { getRenderArtifact } from '@/lib/artifacts/render-artifact'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { appendAgentSessionMetadata } from '@/lib/agents/agent-session-index'
import { createAgentSessionMetadata } from '@/lib/agents/agent-session'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import {
  runVideoEditingSkill,
  type RunVideoEditingSkillInput,
  type RunVideoEditingSkillResult,
  type VideoEditingSkillDescriptor,
} from './video-editing-skill-runner'
import { EditPlanValidationError, parseEditPlan, type EditPlanV1 } from './edit-plan'
import { generateAiEditPlan, type AiEditPlanUsage } from './edit-plan-agent'
import { EditMediaAssetError, getEditMediaAsset, listEditMediaAssets, type EditMediaAssetKind } from './edit-media-asset'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  failProjectStageOperation,
  markProjectStageOperationRunning,
  ProjectStateError,
  getProjectState,
  reconcileProjectStageOperation,
} from '@/lib/project-state/project-state-service'
import {
  registerActivePostProductionTask,
  readPostProductionTaskState,
  PostProductionTaskStateError,
  savePostProductionTaskState,
} from './post-production-task'
import { probeMediaDuration, type ProbeMediaDuration } from '@/lib/media/media-probe'

const BUILTIN_POST_PRODUCTION_SKILL_ID = 'builtin:post-production-cut-review'

export interface PostProductionAgentInput {
  renderArtifactId: string
  request: string
  mode?: 'manual' | 'ai'
  plan: EditPlanV1
}

export type RunPostProductionAgentResult =
  | {
      status: 'ok'
      source: 'post_production_agent'
      artifact: PostProductionArtifact
      skillCall: PostProductionSkillCall
    }
  | {
      status: 'invalid_request' | 'skill_error'
      source: string
      artifact?: PostProductionArtifact
      skillCall?: PostProductionSkillCall
      error: {
        code: string
        message: string
      }
    }

export type GetPostProductionTaskResult =
  | {
      status: 'ok'
      source: 'post_production_task'
      task?: Awaited<ReturnType<typeof readPostProductionTaskState>>
      artifact?: PostProductionArtifact
      project: Awaited<ReturnType<typeof getProjectState>>
    }
  | { status: 'skill_error'; source: 'post_production_task'; error: { code: string; message: string } }

export async function getPostProductionTask(input: {
  projectId: string
  sessionId: string
  now?: string
  recoveryWindowMs?: number
  probeMedia?: ProbeMediaDuration
}): Promise<GetPostProductionTaskResult> {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  let task
  try {
    task = await readPostProductionTaskState(workspace, sessionId, {
      now: input.now,
      recoveryWindowMs: input.recoveryWindowMs,
    })
  } catch (error) {
    if (error instanceof PostProductionTaskStateError) {
      return { status: 'skill_error', source: 'post_production_task', error: { code: error.code, message: error.message } }
    }
    throw error
  }

  const persistedArtifact = task?.status === 'ready' && task.artifactId
    ? await getPostProductionArtifact(workspace, task.artifactId).catch(() => undefined)
    : undefined
  const validatedArtifact = persistedArtifact && await validateRecoveredPostProductionArtifact({
    workspace,
    task: task!,
    artifact: persistedArtifact,
    probeMedia: input.probeMedia ?? probeMediaDuration,
  }) ? persistedArtifact : undefined
  const observation = !task
    ? { status: 'missing' as const, sessionId, source: 'local_ffmpeg' as const }
    : task.status === 'ready'
      ? validatedArtifact
        ? { status: 'ready' as const, operationId: task.taskId, sessionId, source: 'local_ffmpeg' as const, artifactId: validatedArtifact.artifactId }
        : { status: 'failed' as const, operationId: task.taskId, sessionId, source: 'local_ffmpeg' as const, error: { code: 'edit_artifact_invalid', message: '本地剪辑任务已完成，但成片文件无效或已丢失。' } }
      : task.status === 'failed'
        ? { status: 'failed' as const, operationId: task.taskId, sessionId, source: 'local_ffmpeg' as const, error: task.error ?? { code: 'edit_failed', message: '本地剪辑失败。' } }
        : undefined
  const project = observation
    ? await reconcileProjectStageOperation({ projectId, stage: 'edit', task: observation, now: input.now, missingTaskRecoveryWindowMs: input.recoveryWindowMs })
    : await getProjectState(projectId)
  const stage = project.stages.edit
  const artifact = validatedArtifact && task && stage.status === 'ready' && stage.source === 'local_ffmpeg' &&
    stage.artifactId === validatedArtifact.artifactId && stage.operation?.id === task.taskId &&
    stage.operation.sessionId === sessionId && stage.operation.upstreamArtifactId === validatedArtifact.renderArtifactId &&
    project.stages.digitalHuman.status === 'ready' && project.stages.digitalHuman.artifactId === validatedArtifact.renderArtifactId &&
    project.stages.script.status === 'ready' && project.stages.script.artifactId === validatedArtifact.scriptArtifactId
    ? validatedArtifact : undefined
  return { status: 'ok', source: 'post_production_task', task, artifact, project }
}

async function validateRecoveredPostProductionArtifact(input: {
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>
  task: NonNullable<Awaited<ReturnType<typeof readPostProductionTaskState>>>
  artifact: PostProductionArtifact
  probeMedia: ProbeMediaDuration
}) {
  if (input.artifact.status !== 'ready' || input.artifact.sessionId !== input.task.sessionId || input.artifact.artifactId !== input.task.artifactId) return false
  const root = resolveArtifactPath(input.workspace, 'post-production', '.')
  try {
    const safePath = assertInsideRoot(root, input.artifact.outputPath)
    const [rootReal, fileReal, stat] = await Promise.all([fs.realpath(root), fs.realpath(safePath), fs.stat(safePath)])
    assertInsideRoot(rootReal, fileReal)
    if (!stat.isFile() || stat.size <= 0) return false
    const probe = await input.probeMedia({ filePath: safePath })
    return probe.status === 'ok' && probe.durationSeconds > 0
  } catch {
    return false
  }
}

export async function runPostProductionAgent(input: {
  projectId: string
  sessionId: string
  input: PostProductionAgentInput | unknown
  runSkill?: (input: RunVideoEditingSkillInput) => Promise<RunVideoEditingSkillResult>
  generatePlan?: typeof generateAiEditPlan
  createOperationId?: () => string
  now?: string
}): Promise<RunPostProductionAgentResult> {
  try {
    const projectId = assertSafeSegment(input.projectId, 'projectId')
    const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
    const agentInput = normalizePostProductionAgentInput(input.input)
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renderArtifact = await getRenderArtifact(workspace, agentInput.renderArtifactId).catch(() => undefined)
    if (!renderArtifact || renderArtifact.status !== 'ready') {
      return invalidRequest('missing_render_artifact', '未找到可用于后期剪辑的 ready render artifact。')
    }
    const scriptArtifact = await getScriptArtifact(workspace, renderArtifact.scriptArtifactId).catch(() => undefined)
    if (!scriptArtifact) {
      return invalidRequest('missing_script_artifact', '未找到 render 对应的文案 artifact。')
    }
    if (scriptArtifact.approvalStatus !== 'approved') {
      return invalidRequest('script_not_approved', '文案尚未确认，不能进入后期剪辑。')
    }
    const audioArtifact = await getAudioArtifact(workspace, renderArtifact.audioArtifactId).catch(() => undefined)
    if (!audioArtifact) {
      return invalidRequest('missing_audio_artifact', '未找到 render 对应的音频 artifact。')
    }
    if (audioArtifact.status !== 'ready') {
      return invalidRequest('audio_artifact_not_ready', 'render 对应的音频 artifact 尚未就绪，请重新生成音频和数字人视频。')
    }
    if (audioArtifact.parameters.scriptArtifactId !== scriptArtifact.artifactId) {
      return invalidRequest('audio_script_mismatch', '音频 artifact 与 render 文案 artifact 不匹配，请重新生成音频和数字人视频。')
    }
    const renderOutputValidation = await validateRenderOutput(workspace.rootPath, renderArtifact.outputPath)
    if (renderOutputValidation) return renderOutputValidation
    let effectivePlan = agentInput.plan
    let aiPlanning: AiEditPlanUsage | undefined
    if (agentInput.mode === 'ai') {
      const availableAssets = (await listEditMediaAssets(workspace)).map(({ assetId, kind }) => ({ assetId, kind }))
      const generated = await (input.generatePlan ?? generateAiEditPlan)({
        instruction: agentInput.request,
        script: scriptArtifact.content.body,
        currentPlan: agentInput.plan,
        availableAssets,
        videoDurationSeconds: renderArtifact.durationSeconds,
        cacheDirectory: resolveArtifactPath(workspace, 'post-production', '.ai-plan-cache'),
      })
      if (generated.status !== 'ok') {
        return invalidRequest(generated.error.code, generated.error.message, generated.source)
      }
      effectivePlan = generated.plan
      aiPlanning = generated.usage
    }
    const artifactId = assertSafeSegment(
      input.createOperationId?.() ?? `post-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      'operationId',
    )
    const outputPath = resolveArtifactPath(workspace, 'post-production', `${artifactId}.mp4`)
    const subtitlePath = resolveArtifactPath(workspace, 'post-production', `${artifactId}.srt`)
    const coverPath = resolveArtifactPath(workspace, 'post-production', `${artifactId}.png`)
    const parameters = toParameters({ ...agentInput, plan: effectivePlan }, aiPlanning)
    const resolvedSkill = resolveVideoEditingSkill()
    const skillCall = toSkillCall(resolvedSkill)
    const editAssets = await resolveEditAssets(workspace, effectivePlan)

    try {
      await beginProjectStageOperation({
        projectId,
        stage: 'edit',
        operationId: artifactId,
        sessionId,
        source: 'local_ffmpeg',
        expectedUpstreamArtifactId: renderArtifact.artifactId,
        now: input.now,
      })
    } catch (error) {
      return projectStateFailure(error)
    }

    const unregisterActiveTask = registerActivePostProductionTask(workspace, sessionId, artifactId)
    let taskCreatedAt = input.now ?? new Date().toISOString()
    try {
      try {
        const queued = await savePostProductionTaskState({
          workspace,
          sessionId,
          taskId: artifactId,
          artifactId,
          status: 'queued',
          now: input.now,
        })
        taskCreatedAt = queued.createdAt
        await markProjectStageOperationRunning({ projectId, stage: 'edit', operationId: artifactId, now: input.now })
        await savePostProductionTaskState({
          workspace,
          sessionId,
          taskId: artifactId,
          artifactId,
          status: 'running',
          createdAt: taskCreatedAt,
          now: input.now,
        })
      } catch (error) {
        const failure = persistenceFailure('edit_task_start_failed', '本地剪辑任务无法写入持久状态，尚未启动 ffmpeg。', error)
        await failEditOperation(projectId, artifactId, failure.error, input.now)
        return failure
      }

      const skillResult = await (input.runSkill ?? runVideoEditingSkill)({
      projectId,
      workspacePath: workspace.rootPath,
      renderOutputPath: path.normalize(renderArtifact.outputPath),
      scriptText: scriptArtifact.content.body,
      request: agentInput.request,
      plan: effectivePlan,
      outputPath,
      subtitlePath,
      coverPath,
      skill: resolvedSkill,
      editAssets,
      })

      if (skillResult.status !== 'ok') {
      const { artifact } = await savePostProductionArtifact({
        workspace,
        artifactId,
        sessionId,
        status: 'failed',
        source: 'local_ffmpeg',
        renderArtifactId: renderArtifact.artifactId,
        scriptArtifactId: scriptArtifact.artifactId,
        outputPath: path.normalize(outputPath),
        subtitlePath: path.normalize(subtitlePath),
        coverPath: path.normalize(coverPath),
        durationSeconds: 0,
        parameters,
        skillCall,
        error: skillResult.error,
        now: input.now,
      })
      await appendAgentSessionMetadata(
        workspace,
        createAgentSessionMetadata({
          sessionId,
          sessionKind: 'subagent',
          parentSessionId: scriptArtifact.sessionId,
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.rootPath,
          agentRole: 'post_production',
          artifactId: artifact.artifactId,
        }),
      )
        await savePostProductionTaskState({ workspace, sessionId, taskId: artifactId, artifactId, status: 'failed', error: skillResult.error, createdAt: taskCreatedAt, now: input.now })
        await failEditOperation(projectId, artifactId, skillResult.error, input.now)
        return { ...skillResult, artifact, skillCall }
      }

    const { artifact } = await savePostProductionArtifact({
      workspace,
      artifactId,
      sessionId,
      status: 'ready',
      source: 'local_ffmpeg',
      renderArtifactId: renderArtifact.artifactId,
      scriptArtifactId: scriptArtifact.artifactId,
      outputPath: path.normalize(skillResult.outputPath),
      subtitlePath: skillResult.subtitlePath ? path.normalize(skillResult.subtitlePath) : undefined,
      coverPath: skillResult.coverPath ? path.normalize(skillResult.coverPath) : undefined,
      durationSeconds: skillResult.durationSeconds,
      parameters,
      skillCall,
      now: input.now,
    })
    await appendAgentSessionMetadata(
      workspace,
      createAgentSessionMetadata({
        sessionId,
        sessionKind: 'subagent',
        parentSessionId: scriptArtifact.sessionId,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'post_production',
        artifactId: artifact.artifactId,
      }),
    )

      try {
        await savePostProductionTaskState({ workspace, sessionId, taskId: artifactId, artifactId: artifact.artifactId, status: 'ready', createdAt: taskCreatedAt, now: input.now })
        await completeProjectStageOperation({ projectId, stage: 'edit', operationId: artifactId, artifactId: artifact.artifactId, now: input.now })
      } catch (error) {
        const failure = persistenceFailure('edit_task_complete_failed', '成片已生成，但项目状态无法可靠关联该成片。', error)
        await failEditOperation(projectId, artifactId, failure.error, input.now)
        return failure
      }

      return { status: 'ok', source: 'post_production_agent', artifact, skillCall }
    } finally {
      unregisterActiveTask()
    }
  } catch (error) {
    if (error instanceof PostProductionInputValidationError) {
      return invalidRequest(error.code, error.message)
    }
    if (error instanceof EditPlanValidationError) {
      return invalidRequest(error.code, error.message)
    }
    if (error instanceof EditMediaAssetError) {
      return invalidRequest(error.code, error.message)
    }
    if (error instanceof ProjectStateError) return projectStateFailure(error)
    throw error
  }
}

async function resolveEditAssets(workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>, plan: EditPlanV1) {
  async function resolve(assetId: string | undefined, expectedKind: EditMediaAssetKind) {
    if (!assetId) return undefined
    const asset = await getEditMediaAsset(workspace, assetId)
    if (asset.kind !== expectedKind) {
      throw new EditMediaAssetError('asset_kind_mismatch', `所选${expectedKind === 'background_music' ? '背景音乐' : expectedKind === 'intro' ? '片头' : '片尾'}素材类型不匹配。`)
    }
    return assertInsideRoot(workspace.filesPath, asset.path)
  }
  return {
    backgroundMusicPath: plan.backgroundMusic.enabled ? await resolve(plan.backgroundMusic.assetId, 'background_music') : undefined,
    introPath: plan.intro.enabled ? await resolve(plan.intro.assetId, 'intro') : undefined,
    outroPath: plan.outro.enabled ? await resolve(plan.outro.assetId, 'outro') : undefined,
  }
}

class PostProductionInputValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PostProductionInputValidationError'
  }
}

function normalizePostProductionAgentInput(input: PostProductionAgentInput | unknown): PostProductionAgentInput {
  if (!isRecord(input)) {
    throw new PostProductionInputValidationError('invalid_input', '后期剪辑参数格式无效。')
  }
  const renderArtifactId = readRequiredString(input, 'renderArtifactId')
  const request = readRequiredString(input, 'request')
  const mode = input.mode ?? 'manual'
  if (mode !== 'manual' && mode !== 'ai') {
    throw new PostProductionInputValidationError('invalid_mode', '剪辑模式只能是 manual 或 ai。')
  }
  if ('skill' in input) {
    throw new PostProductionInputValidationError('client_skill_forbidden', '剪辑执行器由服务端固定选择，客户端不能指定 skill。')
  }

  return {
    renderArtifactId: assertSafeSegment(renderArtifactId, 'renderArtifactId'),
    request,
    mode,
    plan: parseEditPlan(input.plan),
  }
}

function toParameters(input: PostProductionAgentInput, aiPlanning?: AiEditPlanUsage): PostProductionParameters {
  return {
    plan: input.plan,
    request: input.request,
    ...(aiPlanning ? { aiPlanning } : {}),
  }
}

function resolveVideoEditingSkill(): VideoEditingSkillDescriptor {
  return {
    skillId: BUILTIN_POST_PRODUCTION_SKILL_ID,
    skillName: 'post-production-cut-review',
  }
}

function toSkillCall(skill: VideoEditingSkillDescriptor): PostProductionSkillCall {
  return {
    skillId: skill.skillId,
    skillName: skill.skillName,
  }
}

async function validateRenderOutput(
  workspacePath: string,
  renderOutputPath: string,
): Promise<RunPostProductionAgentResult | undefined> {
  const renderRoot = path.join(workspacePath, 'artifacts', 'render')
  try {
    const safePath = assertInsideRoot(renderRoot, renderOutputPath)
    const stat = await fs.stat(safePath)
    if (!stat.isFile() || stat.size <= 0) {
      return invalidRequest('render_output_missing', '数字人 render 输出视频不存在或为空，请重新生成数字人视频。')
    }
    return undefined
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return invalidRequest('render_output_path_escape', '数字人 render 输出路径越过了当前 workspace render artifact 目录。')
    }
    if (isMissingPathError(error)) {
      return invalidRequest('render_output_missing', '数字人 render 输出视频不存在或为空，请重新生成数字人视频。')
    }
    throw error
  }
}

function isMissingPathError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function readRequiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PostProductionInputValidationError(`invalid_${key}`, `${key} 不能为空。`)
  }
  return value.trim()
}

function invalidRequest(code: string, message: string, source = 'post_production_agent'): RunPostProductionAgentResult {
  return {
    status: 'invalid_request',
    source,
    error: {
      code,
      message,
    },
  }
}

function persistenceFailure(
  code: string,
  message: string,
  error: unknown,
): Exclude<RunPostProductionAgentResult, { status: 'ok' }> {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    status: 'skill_error',
    source: 'post_production_agent',
    error: { code, message: detail ? `${message} 原因：${detail}` : message },
  }
}

function projectStateFailure(error: unknown): RunPostProductionAgentResult {
  if (error instanceof ProjectStateError) return invalidRequest(error.code, error.message, 'project_state')
  return persistenceFailure('project_state_failed', '本地剪辑无法更新项目状态。', error)
}

async function failEditOperation(projectId: string, operationId: string, error: { code: string; message: string }, now?: string) {
  await failProjectStageOperation({ projectId, stage: 'edit', operationId, error, now }).catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
