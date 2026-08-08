import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import {
  POST_PRODUCTION_TASK_RECOVERY_WINDOW_MS,
  readPostProductionTaskState,
  registerActivePostProductionTask,
  savePostProductionTaskState,
} from './post-production-task'

const projectId = 'post-task-store'
const now = '2026-07-17T00:00:00.000Z'
afterEach(async () => fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true }))

describe('post-production task store', () => {
  it('atomically persists and reads terminal state', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await savePostProductionTaskState({ workspace, sessionId: 'post-session', taskId: 'post-task', status: 'ready', artifactId: 'post-task', now })
    await expect(readPostProductionTaskState(workspace, 'post-session')).resolves.toMatchObject({ status: 'ready', artifactId: 'post-task' })
    expect((await fs.readdir(path.join(workspace.artifactsPath, 'post-production'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('recovers an abandoned running task without touching an active task', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const unregister = registerActivePostProductionTask(workspace, 'post-session', 'post-task')
    await savePostProductionTaskState({ workspace, sessionId: 'post-session', taskId: 'post-task', status: 'running', now })
    const later = new Date(Date.parse(now) + POST_PRODUCTION_TASK_RECOVERY_WINDOW_MS + 1).toISOString()
    await expect(readPostProductionTaskState(workspace, 'post-session', { now: later })).resolves.toMatchObject({ status: 'running' })
    unregister()
    await expect(readPostProductionTaskState(workspace, 'post-session', { now: later })).resolves.toMatchObject({ status: 'failed', error: { code: 'task_interrupted' } })
  })

  it('returns a stable error for corrupt task JSON', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const taskPath = path.join(workspace.artifactsPath, 'post-production', '.post-production-task-post-session.json')
    await fs.mkdir(path.dirname(taskPath), { recursive: true })
    await fs.writeFile(taskPath, '{bad', 'utf8')
    await expect(readPostProductionTaskState(workspace, 'post-session')).rejects.toMatchObject({ code: 'task_state_corrupt' })
    await expect(fs.readFile(taskPath, 'utf8')).resolves.toBe('{bad')
  })
})
