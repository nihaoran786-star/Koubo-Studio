import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'

export type IndexTTS2TaskStatus = 'queued' | 'running' | 'ready' | 'failed'

export const INDEXTTS2_TASK_RECOVERY_WINDOW_MS = 15 * 60 * 1_000
const INDEXTTS2_TASK_RUNTIME_OWNER_ID = randomUUID()
const activeIndexTTS2Tasks = new Map<string, number>()

export interface IndexTTS2TaskState {
  taskId: string
  projectId: string
  sessionId: string
  status: IndexTTS2TaskStatus
  runtimeOwnerId?: string
  artifactId?: string
  error?: {
    code: string
    message: string
  }
  createdAt: string
  updatedAt: string
}

export class IndexTTS2TaskStateError extends Error {
  readonly code = 'task_state_corrupt'

  constructor(message = 'IndexTTS2 任务状态文件已损坏，无法恢复任务状态。') {
    super(message)
    this.name = 'IndexTTS2TaskStateError'
  }
}

export function registerActiveIndexTTS2Task(
  workspace: ProjectWorkspace,
  sessionId: string,
  taskId: string,
) {
  const safeSessionId = assertSafeSegment(sessionId, 'sessionId')
  const safeTaskId = assertSafeSegment(taskId, 'taskId')
  const key = activeTaskKey(workspace, safeSessionId, safeTaskId)
  activeIndexTTS2Tasks.set(key, (activeIndexTTS2Tasks.get(key) ?? 0) + 1)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const count = activeIndexTTS2Tasks.get(key) ?? 0
    if (count <= 1) activeIndexTTS2Tasks.delete(key)
    else activeIndexTTS2Tasks.set(key, count - 1)
  }
}

export async function saveIndexTTS2TaskState(input: {
  workspace: ProjectWorkspace
  sessionId: string
  taskId: string
  status: IndexTTS2TaskStatus
  artifactId?: string
  error?: IndexTTS2TaskState['error']
  createdAt?: string
  now?: string
  runtimeOwnerId?: string
}) {
  const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
  const taskId = assertSafeSegment(input.taskId, 'taskId')
  const runtimeOwnerId = input.runtimeOwnerId ?? INDEXTTS2_TASK_RUNTIME_OWNER_ID
  const previous = await readIndexTTS2TaskState(input.workspace, sessionId, {
    now: input.now,
    runtimeOwnerId,
  })
  const now = input.now ?? new Date().toISOString()
  const task: IndexTTS2TaskState = {
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

  await writeIndexTTS2TaskState(input.workspace, task)
  return task
}

export async function readIndexTTS2TaskState(
  workspace: ProjectWorkspace,
  sessionId: string,
  options: {
    now?: string
    recoveryWindowMs?: number
    runtimeOwnerId?: string
  } = {},
): Promise<IndexTTS2TaskState | undefined> {
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
    throw new IndexTTS2TaskStateError()
  }
  if (!isIndexTTS2TaskState(parsed, workspace.projectId, safeSessionId)) {
    throw new IndexTTS2TaskStateError('IndexTTS2 任务状态文件格式无效，无法恢复任务状态。')
  }

  const now = options.now ?? new Date().toISOString()
  const recoveryWindowMs = options.recoveryWindowMs ?? INDEXTTS2_TASK_RECOVERY_WINDOW_MS
  const runtimeOwnerId = options.runtimeOwnerId ?? INDEXTTS2_TASK_RUNTIME_OWNER_ID
  const isActive = isIndexTTS2TaskActive(workspace, parsed.sessionId, parsed.taskId)
  if (shouldRecoverInterruptedTask(parsed, now, recoveryWindowMs, runtimeOwnerId, isActive)) {
    const recovered: IndexTTS2TaskState = {
      ...parsed,
      status: 'failed',
      error: {
        code: 'task_interrupted',
        message: '声音生成曾被异常中断，请重新发起生成。',
      },
      updatedAt: now,
    }
    delete recovered.runtimeOwnerId
    await writeIndexTTS2TaskState(workspace, recovered)
    return recovered
  }

  return parsed
}

async function writeIndexTTS2TaskState(workspace: ProjectWorkspace, task: IndexTTS2TaskState) {
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
  task: IndexTTS2TaskState,
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
    throw new IndexTTS2TaskStateError('IndexTTS2 任务状态包含无效时间，无法恢复任务状态。')
  }
  return nowMs - updatedAtMs > recoveryWindowMs
}

function isIndexTTS2TaskActive(workspace: ProjectWorkspace, sessionId: string, taskId: string) {
  return activeIndexTTS2Tasks.has(activeTaskKey(workspace, sessionId, taskId))
}

function activeTaskKey(workspace: ProjectWorkspace, sessionId: string, taskId: string) {
  return `${workspace.rootPath}\u0000${sessionId}\u0000${taskId}`
}

function resolveTaskPath(workspace: ProjectWorkspace, sessionId: string) {
  return resolveArtifactPath(workspace, 'audio', `.indextts2-task-${sessionId}.json`)
}

function isIndexTTS2TaskState(
  value: unknown,
  projectId: string,
  sessionId: string,
): value is IndexTTS2TaskState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<IndexTTS2TaskState>
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
