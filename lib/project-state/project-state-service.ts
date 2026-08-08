import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertInsideRoot, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import type { ChamberId } from '@/lib/chambers'
import type { ScriptDraft } from '@/lib/workspace'
import type {
  CreationStageId,
  CreationStageSource,
  CreationStageState,
  CreationStageStatus,
  BeginProjectStageOperationInput,
  CompleteProjectStageOperationInput,
  FailProjectStageOperationInput,
  OperableCreationStageId,
  ProjectStateDocument,
  ProjectStateListIssue,
  ProjectStateMutation,
  ReconcileProjectStageOperationInput,
  ProjectStageOperationTransitionInput,
} from './project-state-types'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { getRenderArtifact } from '@/lib/artifacts/render-artifact'
import { getPostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { getPublishPackageArtifact } from '@/lib/artifacts/publish-package-artifact'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'

const STAGES: CreationStageId[] = ['script', 'voice', 'digitalHuman', 'edit', 'publish']
const STEPS: ChamberId[] = ['idea', 'voice', 'avatar', 'render', 'publish']
const OPERABLE_STAGES: OperableCreationStageId[] = ['voice', 'digitalHuman', 'edit', 'publish']
const STAGE_SOURCES: CreationStageSource[] = ['indextts2', 'heygem', 'local_ffmpeg', 'openchatcut', 'local_publish_package']
const PREDECESSOR: Record<OperableCreationStageId, CreationStageId> = {
  voice: 'script',
  digitalHuman: 'voice',
  edit: 'digitalHuman',
  publish: 'edit',
}
const SOURCES_BY_STAGE: Record<OperableCreationStageId, readonly CreationStageSource[]> = {
  voice: ['indextts2'],
  digitalHuman: ['heygem'],
  edit: ['local_ffmpeg', 'openchatcut'],
  publish: ['local_publish_package'],
}
const STAGE_TASK_LABEL: Record<OperableCreationStageId, string> = {
  voice: '声音生成',
  digitalHuman: '数字人生成',
  edit: '本地剪辑',
  publish: '发布准备',
}
const STEP_PREDECESSOR: Partial<Record<ChamberId, CreationStageId>> = {
  voice: 'script',
  avatar: 'voice',
  render: 'digitalHuman',
  publish: 'edit',
}
const projectWriteQueues = new Map<string, Promise<void>>()

export class ProjectStateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ProjectStateError'
  }
}

export async function createProjectState(input: { projectId?: string; script: ScriptDraft; now?: string }) {
  const projectId = assertSafeSegment(input.projectId ?? `project-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, 'projectId')
  return withProjectWriteLock(projectId, async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const existing = await readProjectStateFile(workspace.rootPath).catch((error) => {
      if (error instanceof ProjectStateError && error.code === 'project_not_found') return undefined
      throw error
    })
    if (existing) return existing
    const now = input.now ?? new Date().toISOString()
    const script = normalizeScript(input.script)
    const scriptReady = script.approvalStatus === 'approved' && Boolean(script.artifactId)
    const project: ProjectStateDocument = {
      version: 1,
      revision: 1,
      projectId,
      title: scriptTitle(script),
      status: 'draft',
      currentStep: 'idea',
      furthestStep: 'idea',
      stages: {
        script: stage(scriptReady ? 'ready' : 'needs_input', now, scriptReady ? script.artifactId : undefined),
        voice: stage('needs_input', now),
        digitalHuman: stage('idle', now),
        edit: stage('idle', now),
        publish: stage('idle', now),
      },
      script,
      createdAt: now,
      updatedAt: now,
    }
    await writeProjectState(workspace.rootPath, project)
    return project
  })
}

export async function getProjectState(projectId: string) {
  const workspace = await ensureProjectWorkspace(assertSafeSegment(projectId, 'projectId'), 'digital-human')
  return readProjectStateFile(workspace.rootPath)
}

/**
 * Commits an already-approved script artifact into project.json.
 *
 * This is intentionally a module-level operation rather than a public project
 * mutation: callers cannot manufacture script state without a matching,
 * approved artifact in the same workspace.
 */
export async function approveProjectScriptArtifact(input: {
  projectId: string
  artifactId: string
  now?: string
}) {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const artifactId = assertSafeSegment(input.artifactId, 'artifactId')
  return withProjectWriteLock(projectId, async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const current = await readProjectStateFile(workspace.rootPath)
    const artifact = await getScriptArtifact(workspace, artifactId)
    if (artifact.projectId !== projectId) {
      throw new ProjectStateError('script_artifact_project_mismatch', '文案产物不属于当前项目。')
    }
    if (artifact.approvalStatus !== 'approved') {
      throw new ProjectStateError('script_artifact_not_approved', '文案产物尚未确认。')
    }

    const script = scriptDraftFromArtifact(current.script, artifact)
    const currentStage = current.stages.script
    if (
      scriptFingerprint(current.script) === scriptFingerprint(script) &&
      currentStage.status === 'ready' &&
      currentStage.artifactId === artifactId
    ) {
      return current
    }

    const now = input.now ?? new Date().toISOString()
    const stages = { ...current.stages, script: stage('ready', now, artifactId) }
    cascadeAfter(stages, 'script', now)
    const next = deriveProject({
      ...current,
      revision: current.revision + 1,
      title: scriptTitle(script),
      script,
      stages,
      updatedAt: now,
    })
    await writeProjectState(workspace.rootPath, next)
    return next
  })
}

export async function listProjectStates() {
  const root = getWorkspacesRoot()
  await fs.mkdir(root, { recursive: true })
  const entries = await fs.readdir(root, { withFileTypes: true })
  const issues: ProjectStateListIssue[] = []
  const projects = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    try {
      return await readProjectStateFile(assertInsideRoot(root, path.join(root, entry.name)))
    } catch (error) {
      if (error instanceof ProjectStateError && error.code === 'project_not_found') return undefined
      issues.push(toProjectListIssue(entry.name, error))
      return undefined
    }
  }))
  return {
    projects: projects.filter((project): project is ProjectStateDocument => Boolean(project)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    issues,
  }
}

export async function mutateProjectState(projectId: string, mutation: ProjectStateMutation, now = new Date().toISOString()) {
  const safeProjectId = assertSafeSegment(projectId, 'projectId')
  return withProjectWriteLock(safeProjectId, async () => {
    const workspace = await ensureProjectWorkspace(safeProjectId, 'digital-human')
    const current = await readProjectStateFile(workspace.rootPath)
    if (isNoopMutation(current, mutation)) return current
    if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== current.revision) {
      throw new ProjectStateError('revision_conflict', '项目已在另一个窗口更新，请刷新后重试。')
    }
    await validateArtifactSelection(workspace, current, mutation)
    const next = applyMutation(current, mutation, now)
    await writeProjectState(workspace.rootPath, next)
    return next
  })
}

export async function beginProjectStageOperation(input: BeginProjectStageOperationInput) {
  const normalized = normalizeBeginStageOperation(input)
  return withProjectWriteLock(normalized.projectId, async () => {
    const workspace = await ensureProjectWorkspace(normalized.projectId, 'digital-human')
    const current = await readProjectStateFile(workspace.rootPath)
    const active = current.stages[normalized.stage]
    if ((active.status === 'queued' || active.status === 'running') && active.operation?.id === normalized.operationId) {
      if (
        active.source === normalized.source &&
        active.operation.sessionId === normalized.sessionId &&
        active.operation.upstreamArtifactId === normalized.expectedUpstreamArtifactId
      ) return current
      throw new ProjectStateError('stage_operation_conflict', '相同任务标识对应的创作参数不一致。')
    }
    if (active.status === 'queued' || active.status === 'running') {
      throw new ProjectStateError('stage_operation_in_progress', '该创作阶段已有任务正在运行。')
    }
    assertStagePredecessor(current, normalized.stage, normalized.expectedUpstreamArtifactId)
    const now = normalized.now ?? new Date().toISOString()
    const stages = { ...current.stages }
    stages[normalized.stage] = {
      status: 'queued',
      source: normalized.source,
      operation: {
        id: normalized.operationId,
        sessionId: normalized.sessionId,
        upstreamArtifactId: normalized.expectedUpstreamArtifactId,
        startedAt: now,
      },
      updatedAt: now,
    }
    cascadeAfter(stages, normalized.stage, now)
    const next = deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
    await writeProjectState(workspace.rootPath, next)
    return next
  })
}

export async function markProjectStageOperationRunning(input: ProjectStageOperationTransitionInput) {
  return transitionProjectStageOperation(input, (current, stageId, now) => {
    const currentStage = assertActiveOperation(current, stageId, input.operationId)
    if (currentStage.status === 'running') return current
    const stages = { ...current.stages, [stageId]: { ...currentStage, status: 'running' as const, updatedAt: now } }
    return deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
  })
}

export async function completeProjectStageOperation(input: CompleteProjectStageOperationInput) {
  const artifactId = assertSafeSegment(input.artifactId, 'artifactId')
  return transitionProjectStageOperation(input, async (current, stageId, now, workspace) => {
    const currentStage = assertActiveOperation(current, stageId, input.operationId)
    if (!currentStage.operation || !currentStage.source) {
      throw new ProjectStateError('invalid_stage_operation', '当前创作任务状态不完整。')
    }
    await validateSelectedArtifact(workspace, current, stageId, artifactId, {
      sessionId: currentStage.operation.sessionId,
      source: currentStage.source,
    })
    const stages = { ...current.stages }
    stages[stageId] = {
      status: 'ready',
      artifactId,
      source: currentStage.source,
      operation: currentStage.operation,
      updatedAt: now,
    }
    cascadeAfter(stages, stageId, now)
    return deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
  })
}

export async function failProjectStageOperation(input: FailProjectStageOperationInput) {
  const error = normalizeStageError(input.error)
  return transitionProjectStageOperation(input, (current, stageId, now) => {
    const currentStage = assertActiveOperation(current, stageId, input.operationId)
    const stages = {
      ...current.stages,
      [stageId]: { ...currentStage, status: 'failed' as const, error, updatedAt: now },
    }
    return deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
  })
}

function isActiveStage(stageState: CreationStageState): stageState is CreationStageState & {
  status: 'queued' | 'running'
  source: CreationStageSource
  operation: NonNullable<CreationStageState['operation']>
} {
  return (stageState.status === 'queued' || stageState.status === 'running') && Boolean(stageState.source && stageState.operation)
}

async function writeReconciledStageFailure(input: {
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>
  current: ProjectStateDocument
  stageId: OperableCreationStageId
  currentStage: CreationStageState
  now: string
  error: { code: string; message: string }
}) {
  if (
    input.currentStage.status === 'failed' &&
    input.currentStage.error?.code === input.error.code &&
    input.currentStage.error.message === input.error.message
  ) {
    return input.current
  }
  const stages = {
    ...input.current.stages,
    [input.stageId]: {
      ...input.currentStage,
      status: 'failed' as const,
      error: input.error,
      updatedAt: input.now,
    },
  }
  cascadeAfter(stages, input.stageId, input.now)
  const next = deriveProject({
    ...input.current,
    revision: input.current.revision + 1,
    stages,
    updatedAt: input.now,
  })
  await writeProjectState(input.workspace.rootPath, next)
  return next
}

/**
 * Reconciles a persisted runtime task with project.json under the same project
 * write lock used by normal stage transitions. Runtime task files are evidence,
 * not a second project truth: only the matching operation/session/source may
 * settle an active stage, or invalidate a ready artifact that no longer passes
 * recovery validation, but only for the exact same operation.
 */
export async function reconcileProjectStageOperation(input: ReconcileProjectStageOperationInput) {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const stageId = normalizeOperableStage(input.stage)
  if (!STAGE_SOURCES.includes(input.task.source) || !SOURCES_BY_STAGE[stageId].includes(input.task.source)) {
    throw new ProjectStateError('stage_source_mismatch', '创作阶段与任务来源不匹配。')
  }
  const sessionId = assertSafeSegment(input.task.sessionId, 'sessionId')
  const now = input.now ?? new Date().toISOString()
  return withProjectWriteLock(projectId, async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const current = await readProjectStateFile(workspace.rootPath)
    const currentStage = current.stages[stageId]

    if (input.task.status === 'missing') {
      if (!isActiveStage(currentStage) || currentStage.source !== input.task.source || currentStage.operation?.sessionId !== sessionId) {
        return current
      }
      const recoveryWindowMs = input.missingTaskRecoveryWindowMs ?? 15 * 60 * 1_000
      if (!Number.isFinite(recoveryWindowMs) || recoveryWindowMs < 0) {
        throw new ProjectStateError('invalid_recovery_window', '任务恢复时间窗口无效。')
      }
      const nowMs = Date.parse(now)
      const startedAtMs = Date.parse(currentStage.operation.startedAt)
      if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs)) {
        throw new ProjectStateError('invalid_stage_operation', '当前创作任务包含无效时间。')
      }
      if (nowMs - startedAtMs <= recoveryWindowMs) return current
      return writeReconciledStageFailure({
        workspace,
        current,
        stageId,
        currentStage,
        now,
        error: { code: 'task_interrupted', message: `${STAGE_TASK_LABEL[stageId]}曾被异常中断，请重新发起。` },
      })
    }

    const operationId = assertSafeSegment(input.task.operationId, 'operationId')
    const matchesOperation =
      currentStage.operation?.id === operationId &&
      currentStage.operation.sessionId === sessionId &&
      currentStage.source === input.task.source

    if (input.task.status === 'failed') {
      if ((!isActiveStage(currentStage) && currentStage.status !== 'ready') || !matchesOperation) return current
      return writeReconciledStageFailure({
        workspace,
        current,
        stageId,
        currentStage,
        now,
        error: normalizeStageError(input.task.error),
      })
    }

    const artifactId = assertSafeSegment(input.task.artifactId, 'artifactId')
    const isSameReadyArtifact =
      currentStage.status === 'ready' &&
      currentStage.artifactId === artifactId &&
      currentStage.source === input.task.source
    if (isSameReadyArtifact && currentStage.operation && !matchesOperation) return current
    if (!isSameReadyArtifact && !matchesOperation) return current
    if (!isSameReadyArtifact && currentStage.status !== 'queued' && currentStage.status !== 'running' && currentStage.status !== 'failed') {
      return current
    }

    try {
      await validateSelectedArtifact(workspace, current, stageId, artifactId, {
        sessionId,
        source: input.task.source,
      })
    } catch (error) {
      const typed = error instanceof ProjectStateError
        ? { code: error.code, message: error.message }
        : { code: 'stage_artifact_invalid', message: `${STAGE_TASK_LABEL[stageId]}产物无法验证。` }
      if (isSameReadyArtifact && currentStage.operation && matchesOperation) {
        return writeReconciledStageFailure({ workspace, current, stageId, currentStage, now, error: typed })
      }
      if (isSameReadyArtifact) return current
      return writeReconciledStageFailure({ workspace, current, stageId, currentStage, now, error: typed })
    }

    if (isSameReadyArtifact) return current
    const stages = { ...current.stages }
    stages[stageId] = {
      status: 'ready',
      artifactId,
      source: input.task.source,
      operation: currentStage.operation,
      updatedAt: now,
    }
    cascadeAfter(stages, stageId, now)
    const next = deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
    await writeProjectState(workspace.rootPath, next)
    return next
  })
}

export function applyMutation(current: ProjectStateDocument, mutation: ProjectStateMutation, now: string): ProjectStateDocument {
  if (mutation.operation === 'update_script') {
    const script = normalizeScript(mutation.script)
    const contentChanged = scriptFingerprint(current.script) !== scriptFingerprint(script)
    return deriveProject({
      ...current,
      revision: current.revision + 1,
      title: scriptTitle(script),
      script,
      stages: contentChanged
        ? {
            script: stage(script.approvalStatus === 'approved' && script.artifactId ? 'ready' : 'needs_input', now, script.approvalStatus === 'approved' ? script.artifactId : undefined),
            voice: stage('needs_input', now),
            digitalHuman: stage('idle', now),
            edit: stage('idle', now),
            publish: stage('idle', now),
          }
        : {
            ...current.stages,
            script: stage(script.approvalStatus === 'approved' && script.artifactId ? 'ready' : 'needs_input', now, script.approvalStatus === 'approved' ? script.artifactId : undefined),
          },
      updatedAt: now,
    })
  }
  if (mutation.operation === 'set_current_step') {
    if (!STEPS.includes(mutation.step)) throw new ProjectStateError('invalid_step', '创作阶段无效。')
    if (mutation.step === current.currentStep) return current
    assertStepCanBeEntered(current, mutation.step)
    const furthestStep = STEPS.indexOf(mutation.step) > STEPS.indexOf(current.furthestStep) ? mutation.step : current.furthestStep
    return deriveProject({ ...current, revision: current.revision + 1, currentStep: mutation.step, furthestStep, updatedAt: now })
  }
  if (mutation.operation === 'select_artifact') {
    if (!OPERABLE_STAGES.includes(mutation.stage) || typeof mutation.artifactId !== 'string') {
      throw new ProjectStateError('invalid_artifact_selection', '创作产物选择无效。')
    }
    const artifactId = assertSafeSegment(mutation.artifactId, 'artifactId')
    if (current.stages[mutation.stage].status === 'ready' && current.stages[mutation.stage].artifactId === artifactId) return current
    const stages = { ...current.stages }
    stages[mutation.stage] = stage('ready', now, artifactId)
    cascadeAfter(stages, mutation.stage, now)
    return deriveProject({ ...current, revision: current.revision + 1, stages, updatedAt: now })
  }
  return assertNever(mutation)
}

async function validateArtifactSelection(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  current: ProjectStateDocument,
  mutation: ProjectStateMutation,
) {
  if (mutation.operation !== 'select_artifact') return
  return validateSelectedArtifact(workspace, current, mutation.stage, mutation.artifactId)
}

async function validateSelectedArtifact(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  current: ProjectStateDocument,
  selectedStage: OperableCreationStageId,
  selectedArtifactId: string,
  expectedOperation?: { sessionId: string; source: CreationStageSource },
) {
  const artifactId = assertSafeSegment(selectedArtifactId, 'artifactId')
  const predecessorId = PREDECESSOR[selectedStage]
  const predecessor = current.stages[predecessorId]
  if (predecessor.status !== 'ready' || !predecessor.artifactId) {
    throw new ProjectStateError('stage_prerequisite_not_ready', '请先完成上一创作阶段。')
  }
  if (selectedStage === 'voice') {
    const artifact = await getAudioArtifact(workspace, artifactId).catch(() => undefined)
    if (!artifact || artifact.status !== 'ready') throw new ProjectStateError('invalid_audio_artifact', '声音产物不存在或尚未就绪。')
    assertArtifactOperationMatch(artifact, expectedOperation)
    if (artifact.parameters.scriptArtifactId !== predecessor.artifactId) {
      throw new ProjectStateError('audio_script_mismatch', '声音产物不属于当前文案。')
    }
    return
  }
  if (selectedStage === 'digitalHuman') {
    const artifact = await getRenderArtifact(workspace, artifactId).catch(() => undefined)
    if (!artifact || artifact.status !== 'ready') throw new ProjectStateError('invalid_render_artifact', '数字人产物不存在或尚未就绪。')
    assertArtifactOperationMatch(artifact, expectedOperation)
    if (artifact.audioArtifactId !== predecessor.artifactId) throw new ProjectStateError('render_audio_mismatch', '数字人产物不属于当前声音。')
    if (artifact.scriptArtifactId !== current.stages.script.artifactId) throw new ProjectStateError('render_script_mismatch', '数字人产物不属于当前文案。')
    return
  }
  if (selectedStage === 'edit') {
    const artifact = await getPostProductionArtifact(workspace, artifactId).catch(() => undefined)
    if (!artifact || artifact.status !== 'ready') throw new ProjectStateError('invalid_edit_artifact', '成片不存在或尚未就绪。')
    assertArtifactOperationMatch(artifact, expectedOperation)
    if (artifact.renderArtifactId !== predecessor.artifactId) throw new ProjectStateError('edit_render_mismatch', '成片不属于当前数字人视频。')
    if (artifact.scriptArtifactId !== current.stages.script.artifactId) throw new ProjectStateError('edit_script_mismatch', '成片不属于当前文案。')
    return
  }
  const artifact = await getPublishPackageArtifact(workspace, artifactId).catch(() => undefined)
  if (!artifact || artifact.status !== 'ready') throw new ProjectStateError('invalid_publish_artifact', '发布包不存在或尚未就绪。')
  assertArtifactOperationMatch(artifact, expectedOperation)
  if (artifact.postProductionArtifactId !== predecessor.artifactId) throw new ProjectStateError('publish_edit_mismatch', '发布包不属于当前成片。')
  if (artifact.scriptArtifactId !== current.stages.script.artifactId) throw new ProjectStateError('publish_script_mismatch', '发布包不属于当前文案。')
}

function assertArtifactOperationMatch(
  artifact: { sessionId: string; source: string },
  expectedOperation?: { sessionId: string; source: CreationStageSource },
) {
  if (!expectedOperation) return
  if (artifact.sessionId !== expectedOperation.sessionId) {
    throw new ProjectStateError('stage_artifact_session_mismatch', '创作产物不属于当前任务会话。')
  }
  if (artifact.source !== expectedOperation.source) {
    throw new ProjectStateError('stage_artifact_source_mismatch', '创作产物来源与当前任务不匹配。')
  }
}

function cascadeAfter(stages: ProjectStateDocument['stages'], stageId: CreationStageId, now: string) {
  const index = STAGES.indexOf(stageId)
  for (let position = index + 1; position < STAGES.length; position += 1) {
    const id = STAGES[position]
    stages[id] = stage(position === index + 1 ? 'needs_input' : 'idle', now)
  }
}

function scriptDraftFromArtifact(
  current: ScriptDraft,
  artifact: Awaited<ReturnType<typeof getScriptArtifact>>,
): ScriptDraft {
  return normalizeScript({
    ...current,
    artifactId: artifact.artifactId,
    approvalStatus: 'approved',
    duration: `${artifact.content.durationSeconds} 秒`,
    chatStage: 'generated',
    title: artifact.content.title,
    hook: artifact.content.hook,
    body: artifact.content.body,
    caption: artifact.content.caption,
    tags: artifact.content.tags,
    generated: true,
    updatedAt: artifact.updatedAt,
  })
}

function deriveProject(project: ProjectStateDocument): ProjectStateDocument {
  const status = project.stages.publish.status === 'ready'
    ? 'pending'
    : project.stages.script.status === 'needs_input'
      ? 'draft'
      : 'editing'
  return { ...project, status }
}

function stage(status: CreationStageStatus, updatedAt: string, artifactId?: string): CreationStageState {
  return { status, ...(artifactId ? { artifactId } : {}), updatedAt }
}

function statePath(rootPath: string) {
  return assertInsideRoot(rootPath, path.join(rootPath, 'project.json'))
}

export async function readProjectStateFromWorkspaceRoot(rootPath: string): Promise<ProjectStateDocument> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(rootPath), 'utf8')) as ProjectStateDocument
    if (!isProjectState(parsed)) throw new ProjectStateError('invalid_project_state', 'project.json 格式无效。')
    return parsed
  } catch (error) {
    if (error instanceof ProjectStateError) throw error
    if (error instanceof SyntaxError) throw new ProjectStateError('invalid_project_state', 'project.json 格式无效。')
    if (isNodeError(error, 'ENOENT')) throw new ProjectStateError('project_not_found', '未找到创作项目。')
    throw error
  }
}

const readProjectStateFile = readProjectStateFromWorkspaceRoot

function toProjectListIssue(projectId: string, error: unknown): ProjectStateListIssue {
  if (error instanceof ProjectStateError && error.code === 'invalid_project_state') {
    return { projectId, code: error.code, message: '项目数据已损坏，暂时无法打开。' }
  }
  return { projectId, code: 'project_read_failed', message: '项目数据读取失败，暂时无法打开。' }
}

async function writeProjectState(rootPath: string, project: ProjectStateDocument) {
  const target = statePath(rootPath)
  const temporary = assertInsideRoot(rootPath, path.join(rootPath, `.project-${process.pid}-${randomUUID()}.tmp`))
  const handle = await fs.open(temporary, 'wx')
  try {
    try {
      await handle.writeFile(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await fs.rename(temporary, target)
        return
      } catch (error) {
        if (attempt === 5 || (!isNodeError(error, 'EPERM') && !isNodeError(error, 'EACCES') && !isNodeError(error, 'EEXIST'))) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * 40))
      }
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function normalizeScript(value: ScriptDraft): ScriptDraft {
  if (!value || typeof value !== 'object') throw new ProjectStateError('invalid_script', '文案状态无效。')
  return {
    ...value,
    artifactId: value.artifactId ? assertSafeSegment(value.artifactId, 'scriptArtifactId') : undefined,
    approvalStatus: value.approvalStatus === 'approved' ? 'approved' : 'draft',
    platforms: Array.isArray(value.platforms) ? value.platforms.filter((item): item is string => typeof item === 'string') : [],
    messages: Array.isArray(value.messages) ? value.messages.filter((item) => item && typeof item.id === 'string' && (item.role === 'ai' || item.role === 'user') && typeof item.text === 'string') : [],
    tags: Array.isArray(value.tags) ? value.tags.filter((item): item is string => typeof item === 'string') : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

function scriptFingerprint(script: ScriptDraft) {
  return JSON.stringify([script.artifactId, script.approvalStatus, script.title, script.hook, script.body, script.caption, script.tags])
}

function scriptTitle(script: ScriptDraft) { return script.title.trim() || script.topic.trim() || '未命名口播作品' }
function isStageStatus(value: unknown): value is CreationStageStatus { return value === 'idle' || value === 'needs_input' || value === 'queued' || value === 'running' || value === 'ready' || value === 'failed' }
function isNodeError(error: unknown, code: string) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code) }
function isProjectState(value: ProjectStateDocument) {
  return value?.version === 1 && Number.isInteger(value.revision) && value.revision > 0 && typeof value.projectId === 'string' && typeof value.title === 'string' && STEPS.includes(value.currentStep) && STEPS.includes(value.furthestStep) && STAGES.every((id) => isValidStageState(value.stages?.[id])) && value.script && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}

function isValidStageState(value: CreationStageState | undefined) {
  if (!value || !isStageStatus(value.status) || typeof value.updatedAt !== 'string') return false
  if (value.status === 'ready' && typeof value.artifactId !== 'string') return false
  if (value.source !== undefined && !STAGE_SOURCES.includes(value.source)) return false
  if (value.operation !== undefined && !isValidStageOperation(value.operation)) return false
  if (value.status === 'queued' || value.status === 'running') {
    return Boolean(value.source && value.operation)
  }
  return true
}

function isValidStageOperation(value: CreationStageState['operation']) {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.upstreamArtifactId === 'string' &&
    typeof value.startedAt === 'string',
  )
}

function assertStepCanBeEntered(current: ProjectStateDocument, step: ChamberId) {
  if (STEPS.indexOf(step) < STEPS.indexOf(current.currentStep)) return
  const prerequisiteId = STEP_PREDECESSOR[step]
  if (!prerequisiteId) return
  const prerequisite = current.stages[prerequisiteId]
  if (prerequisite.status !== 'ready' || !prerequisite.artifactId) {
    throw new ProjectStateError('stage_prerequisite_not_ready', '请先完成上一创作阶段。')
  }
}

function assertStagePredecessor(current: ProjectStateDocument, stageId: OperableCreationStageId, expectedArtifactId: string) {
  const predecessorId = PREDECESSOR[stageId]
  const predecessor = current.stages[predecessorId]
  if (predecessor.status !== 'ready' || !predecessor.artifactId) {
    throw new ProjectStateError('stage_prerequisite_not_ready', '请先完成上一创作阶段。')
  }
  if (predecessor.artifactId !== expectedArtifactId) {
    throw new ProjectStateError('stage_upstream_mismatch', '上游产物已变化，请刷新后重新开始。')
  }
}

function assertActiveOperation(current: ProjectStateDocument, stageId: OperableCreationStageId, operationId: string) {
  const currentStage = current.stages[stageId]
  if ((currentStage.status !== 'queued' && currentStage.status !== 'running') || currentStage.operation?.id !== operationId) {
    throw new ProjectStateError('stage_operation_stale', '该任务已被更新的创作操作替代。')
  }
  return currentStage
}

function normalizeBeginStageOperation(input: BeginProjectStageOperationInput) {
  const stageId = normalizeOperableStage(input.stage)
  if (!STAGE_SOURCES.includes(input.source)) throw new ProjectStateError('invalid_stage_source', '创作阶段来源无效。')
  if (!SOURCES_BY_STAGE[stageId].includes(input.source)) throw new ProjectStateError('stage_source_mismatch', '创作阶段与运行来源不匹配。')
  return {
    ...input,
    projectId: assertSafeSegment(input.projectId, 'projectId'),
    stage: stageId,
    operationId: assertSafeSegment(input.operationId, 'operationId'),
    sessionId: assertSafeSegment(input.sessionId, 'sessionId'),
    expectedUpstreamArtifactId: assertSafeSegment(input.expectedUpstreamArtifactId, 'expectedUpstreamArtifactId'),
  }
}

function normalizeOperableStage(stageId: OperableCreationStageId) {
  if (!OPERABLE_STAGES.includes(stageId)) throw new ProjectStateError('invalid_stage', '创作阶段无效。')
  return stageId
}

function normalizeStageError(error: { code: string; message: string }) {
  if (!error || typeof error.code !== 'string' || !error.code.trim() || typeof error.message !== 'string' || !error.message.trim()) {
    throw new ProjectStateError('invalid_stage_error', '创作阶段错误无效。')
  }
  return { code: error.code.trim(), message: error.message.trim() }
}

async function transitionProjectStageOperation(
  input: ProjectStageOperationTransitionInput,
  transition: (
    current: ProjectStateDocument,
    stageId: OperableCreationStageId,
    now: string,
    workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  ) => ProjectStateDocument | Promise<ProjectStateDocument>,
) {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const stageId = normalizeOperableStage(input.stage)
  assertSafeSegment(input.operationId, 'operationId')
  return withProjectWriteLock(projectId, async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const current = await readProjectStateFile(workspace.rootPath)
    const next = await transition(current, stageId, input.now ?? new Date().toISOString(), workspace)
    if (next === current) return current
    await writeProjectState(workspace.rootPath, next)
    return next
  })
}

function isNoopMutation(current: ProjectStateDocument, mutation: ProjectStateMutation) {
  if (mutation.operation === 'set_current_step') return mutation.step === current.currentStep
  return mutation.operation === 'select_artifact' && OPERABLE_STAGES.includes(mutation.stage) && current.stages[mutation.stage].status === 'ready' && current.stages[mutation.stage].artifactId === mutation.artifactId
}

function withProjectWriteLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectWriteQueues.get(projectId) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const settled = result.then(() => undefined, () => undefined)
  projectWriteQueues.set(projectId, settled)
  return result.finally(() => {
    if (projectWriteQueues.get(projectId) === settled) projectWriteQueues.delete(projectId)
  })
}

function assertNever(value: never): never {
  throw new ProjectStateError('invalid_mutation', `项目更新指令无效：${String(value)}`)
}
