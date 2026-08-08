import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'

export type HeyGemTaskStatus = 'queued' | 'running' | 'ready' | 'failed'

export const HEYGEM_TASK_RECOVERY_WINDOW_MS = 15 * 60 * 1_000
const HEYGEM_TASK_RUNTIME_OWNER_ID = randomUUID()
const activeHeyGemTasks = new Map<string, number>()

export interface HeyGemTaskState {
  taskId: string
  projectId: string
  sessionId: string
  status: HeyGemTaskStatus
  runtimeOwnerId?: string
  artifactId?: string
  error?: {
    code: string
    message: string
  }
  createdAt: string
  updatedAt: string
}

export class HeyGemTaskStateError extends Error {
  readonly code = 'task_state_corrupt'

  constructor(message = 'HeyGem 任务状态文件已损坏，无法恢复任务状态。') {
    super(message)
    this.name = 'HeyGemTaskStateError'
  }
}

export function registerActiveHeyGemTask(
  workspace: ProjectWorkspace,
  sessionId: string,
  taskId: string,
) {
  const safeSessionId = assertSafeSegment(sessionId, 'sessionId')
  const safeTaskId = assertSafeSegment(taskId, 'taskId')
  const key = activeTaskKey(workspace, safeSessionId, safeTaskId)
  activeHeyGemTasks.set(key, (activeHeyGemTasks.get(key) ?? 0) + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const count = activeHeyGemTasks.get(key) ?? 0
    if (count <= 1) activeHeyGemTasks.delete(key)
    else activeHeyGemTasks.set(key, count - 1)
  }
}

export async function saveHeyGemTaskState(input: {
  workspace: ProjectWorkspace
  sessionId: string
  taskId: string
  status: HeyGemTaskStatus
  artifactId?: string
  error?: HeyGemTaskState['error']
  createdAt?: string
  now?: string
  runtimeOwnerId?: string
}) {
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const taskId = assertSafeSegment(input.taskId, 'taskId')
  const runtimeOwnerId = input.runtimeOwnerId ?? HEYGEM_TASK_RUNTIME_OWNER_ID
  const previous = await readHeyGemTaskState(input.workspace, sessionId, {
    now: input.now,
    runtimeOwnerId,
  })
  const now = input.now ?? new Date().toISOString()
  const task: HeyGemTaskState = {
    taskId,
    projectId: input.workspace.projectId,
    sessionId,
    status: input.status,
    runtimeOwnerId: input.status === 'queued' || input.status === 'running' ? runtimeOwnerId : undefined,
    artifactId: input.artifactId,
    error: input.error,
    createdAt: input.createdAt ?? previous?.createdAt ?? now,
    updatedAt: now,
  }
  if (!task.artifactId) delete task.artifactId
  if (!task.error) delete task.error
  if (!task.runtimeOwnerId) delete task.runtimeOwnerId

  await writeHeyGemTaskState(input.workspace, task)
  return task
}

export async function readHeyGemTaskState(
  workspace: ProjectWorkspace,
  sessionId: string,
  options: {
    now?: string
    recoveryWindowMs?: number
    runtimeOwnerId?: string
  } = {},
): Promise<HeyGemTaskState | undefined> {
  const safeSessionId = assertSafeSegment(sessionId, 'sessionId')
  const taskPath = resolveTaskPath(workspace, safeSessionId)
  let raw: string
  try {
    raw = await fs.readFile(taskPath, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new HeyGemTaskStateError()
  }
  if (!isHeyGemTaskState(parsed, workspace.projectId, safeSessionId)) {
    throw new HeyGemTaskStateError('HeyGem 任务状态文件格式无效，无法恢复任务状态。')
  }

  const now = options.now ?? new Date().toISOString()
  const recoveryWindowMs = options.recoveryWindowMs ?? HEYGEM_TASK_RECOVERY_WINDOW_MS
  const runtimeOwnerId = options.runtimeOwnerId ?? HEYGEM_TASK_RUNTIME_OWNER_ID
  const isActive = isHeyGemTaskActive(workspace, parsed.sessionId, parsed.taskId)
  if (shouldRecoverInterruptedTask(parsed, now, recoveryWindowMs, runtimeOwnerId, isActive)) {
    const recovered: HeyGemTaskState = {
      ...parsed,
      status: 'failed',
      error: {
        code: 'task_interrupted',
        message: '数字人生成曾被异常中断，请重新发起生成。',
      },
      updatedAt: now,
    }
    delete recovered.runtimeOwnerId
    await writeHeyGemTaskState(workspace, recovered)
    return recovered
  }

  return parsed
}

async function writeHeyGemTaskState(workspace: ProjectWorkspace, task: HeyGemTaskState) {
  const taskPath = resolveTaskPath(workspace, task.sessionId)
  const directory = path.dirname(taskPath)
  await fs.mkdir(directory, { recursive: true })
  const tempPath = path.join(directory, `.${path.basename(taskPath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(tempPath, taskPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function shouldRecoverInterruptedTask(
  task: HeyGemTaskState,
  now: string,
  recoveryWindowMs: number,
  runtimeOwnerId: string,
  isActive: boolean,
) {
  if (task.status !== 'queued' && task.status !== 'running') return false
  if (task.runtimeOwnerId === runtimeOwnerId && isActive) return false
  const nowMs = Date.parse(now)
  const updatedAtMs = Date.parse(task.updatedAt)
  if (!Number.isFinite(nowMs) || !Number.isFinite(updatedAtMs)) {
    throw new HeyGemTaskStateError('HeyGem 任务状态包含无效时间，无法恢复任务状态。')
  }
  return nowMs - updatedAtMs > recoveryWindowMs
}

function isHeyGemTaskActive(workspace: ProjectWorkspace, sessionId: string, taskId: string) {
  return activeHeyGemTasks.has(activeTaskKey(workspace, sessionId, taskId))
}

function activeTaskKey(workspace: ProjectWorkspace, sessionId: string, taskId: string) {
  return `${workspace.rootPath}\u0000${sessionId}\u0000${taskId}`
}

function resolveTaskPath(workspace: ProjectWorkspace, sessionId: string) {
  return resolveArtifactPath(workspace, 'render', `.heygem-task-${sessionId}.json`)
}

function isHeyGemTaskState(
  value: unknown,
  projectId: string,
  sessionId: string,
): value is HeyGemTaskState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<HeyGemTaskState>
  return (
    typeof candidate.taskId === 'string' &&
    candidate.projectId === projectId &&
    candidate.sessionId === sessionId &&
    (candidate.status === 'queued' || candidate.status === 'running' || candidate.status === 'ready' || candidate.status === 'failed') &&
    (candidate.runtimeOwnerId === undefined ||
      (typeof candidate.runtimeOwnerId === 'string' && candidate.runtimeOwnerId.length > 0)) &&
    typeof candidate.createdAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    (candidate.artifactId === undefined || typeof candidate.artifactId === 'string') &&
    (candidate.error === undefined ||
      (typeof candidate.error === 'object' && candidate.error !== null &&
        typeof candidate.error.code === 'string' && typeof candidate.error.message === 'string'))
  )
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
