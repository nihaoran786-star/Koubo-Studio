import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { writeJsonFileAtomically } from '@/lib/artifacts/atomic-json-file'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'

export type PostProductionTaskStatus = 'queued' | 'running' | 'ready' | 'failed'
export const POST_PRODUCTION_TASK_RECOVERY_WINDOW_MS = 15 * 60 * 1_000
const RUNTIME_OWNER_ID = randomUUID()
const activeTasks = new Map<string, number>()

export interface PostProductionTaskState {
  taskId: string
  projectId: string
  sessionId: string
  status: PostProductionTaskStatus
  runtimeOwnerId?: string
  artifactId?: string
  error?: { code: string; message: string }
  createdAt: string
  updatedAt: string
}

export class PostProductionTaskStateError extends Error {
  readonly code = 'task_state_corrupt'
  constructor(message = '本地剪辑任务状态文件已损坏，无法恢复任务状态。') {
    super(message)
    this.name = 'PostProductionTaskStateError'
  }
}

export function registerActivePostProductionTask(workspace: ProjectWorkspace, sessionId: string, taskId: string) {
  const key = taskKey(workspace, assertSafeSegment(sessionId, 'sessionId'), assertSafeSegment(taskId, 'taskId'))
  activeTasks.set(key, (activeTasks.get(key) ?? 0) + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const count = activeTasks.get(key) ?? 0
    if (count <= 1) activeTasks.delete(key)
    else activeTasks.set(key, count - 1)
  }
}

export async function savePostProductionTaskState(input: {
  workspace: ProjectWorkspace
  sessionId: string
  taskId: string
  status: PostProductionTaskStatus
  artifactId?: string
  error?: PostProductionTaskState['error']
  createdAt?: string
  now?: string
  runtimeOwnerId?: string
}) {
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const taskId = assertSafeSegment(input.taskId, 'taskId')
  const runtimeOwnerId = input.runtimeOwnerId ?? RUNTIME_OWNER_ID
  const previous = await readPostProductionTaskState(input.workspace, sessionId, { now: input.now, runtimeOwnerId })
  const now = input.now ?? new Date().toISOString()
  const task: PostProductionTaskState = {
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
  if (!task.runtimeOwnerId) delete task.runtimeOwnerId
  if (!task.artifactId) delete task.artifactId
  if (!task.error) delete task.error
  await writeJsonFileAtomically(taskPath(input.workspace, sessionId), task)
  return task
}

export async function readPostProductionTaskState(
  workspace: ProjectWorkspace,
  sessionId: string,
  options: { now?: string; recoveryWindowMs?: number; runtimeOwnerId?: string } = {},
): Promise<PostProductionTaskState | undefined> {
  const safeSessionId = assertSafeSegment(sessionId, 'sessionId')
  const filePath = taskPath(workspace, safeSessionId)
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    if (isMissing(error)) return undefined
    if (error instanceof SyntaxError) throw new PostProductionTaskStateError()
    throw error
  }
  if (!isTask(parsed, workspace.projectId, safeSessionId)) throw new PostProductionTaskStateError('本地剪辑任务状态文件格式无效，无法恢复任务状态。')
  const now = options.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  const updatedMs = Date.parse(parsed.updatedAt)
  if (!Number.isFinite(nowMs) || !Number.isFinite(updatedMs)) throw new PostProductionTaskStateError('本地剪辑任务状态包含无效时间。')
  const isRunning = parsed.status === 'queued' || parsed.status === 'running'
  const isActive = activeTasks.has(taskKey(workspace, parsed.sessionId, parsed.taskId))
  const currentOwner = parsed.runtimeOwnerId === (options.runtimeOwnerId ?? RUNTIME_OWNER_ID)
  if (isRunning && !(currentOwner && isActive) && nowMs - updatedMs > (options.recoveryWindowMs ?? POST_PRODUCTION_TASK_RECOVERY_WINDOW_MS)) {
    const recovered: PostProductionTaskState = {
      ...parsed,
      status: 'failed',
      error: { code: 'task_interrupted', message: '本地剪辑曾被异常中断，请重新导出。' },
      updatedAt: now,
    }
    delete recovered.runtimeOwnerId
    await writeJsonFileAtomically(filePath, recovered)
    return recovered
  }
  return parsed
}

function taskPath(workspace: ProjectWorkspace, sessionId: string) {
  return resolveArtifactPath(workspace, 'post-production', `.post-production-task-${sessionId}.json`)
}
function taskKey(workspace: ProjectWorkspace, sessionId: string, taskId: string) { return `${workspace.rootPath}\u0000${sessionId}\u0000${taskId}` }
function isMissing(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') }
function isTask(value: unknown, projectId: string, sessionId: string): value is PostProductionTaskState {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<PostProductionTaskState>
  return typeof task.taskId === 'string' && task.projectId === projectId && task.sessionId === sessionId &&
    (task.status === 'queued' || task.status === 'running' || task.status === 'ready' || task.status === 'failed') &&
    (task.runtimeOwnerId === undefined || typeof task.runtimeOwnerId === 'string') &&
    (task.artifactId === undefined || typeof task.artifactId === 'string') &&
    (task.error === undefined || Boolean(task.error && typeof task.error.code === 'string' && typeof task.error.message === 'string')) &&
    typeof task.createdAt === 'string' && Number.isFinite(Date.parse(task.createdAt)) &&
    typeof task.updatedAt === 'string' && Number.isFinite(Date.parse(task.updatedAt))
}
