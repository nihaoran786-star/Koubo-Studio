import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import {
  HEYGEM_TASK_RECOVERY_WINDOW_MS,
  HeyGemTaskStateError,
  readHeyGemTaskState,
  registerActiveHeyGemTask,
  saveHeyGemTaskState,
} from './heygem-task'

const projectId = 'test-heygem-task-store'
const initialTime = '2026-07-17T00:00:00.000Z'

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('HeyGem task store', () => {
  it('writes through a unique same-directory temp file and atomically renames it', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renameSpy = vi.spyOn(fs, 'rename')

    await saveHeyGemTaskState({
      workspace,
      sessionId: 'session-atomic',
      taskId: 'task-atomic',
      status: 'queued',
      now: initialTime,
    })

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [temporaryPath, finalPath] = renameSpy.mock.calls[0] as [string, string]
    expect(path.dirname(temporaryPath)).toBe(path.dirname(finalPath))
    expect(path.basename(temporaryPath)).toMatch(/^\.\.heygem-task-session-atomic\.json\.\d+\..+\.tmp$/)
    expect(finalPath).toBe(taskPath(workspace.artifactsPath, 'session-atomic'))
    await expect(fs.stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes its temp file when atomic rename fails', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EIO' }))

    await expect(
      saveHeyGemTaskState({
        workspace,
        sessionId: 'session-cleanup',
        taskId: 'task-cleanup',
        status: 'running',
        now: initialTime,
      }),
    ).rejects.toThrow('rename failed')

    const renderDirectory = path.join(workspace.artifactsPath, 'render')
    const entries = await fs.readdir(renderDirectory)
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    await expect(fs.stat(taskPath(workspace.artifactsPath, 'session-cleanup'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not reuse temp names across concurrent writes', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renameSpy = vi.spyOn(fs, 'rename')

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveHeyGemTaskState({
          workspace,
          sessionId: `session-${index}`,
          taskId: `task-${index}`,
          status: 'queued',
          now: initialTime,
        }),
      ),
    )

    const temporaryPaths = renameSpy.mock.calls.map(([temporaryPath]) => String(temporaryPath))
    expect(new Set(temporaryPaths).size).toBe(temporaryPaths.length)
  })

  it.each(['queued', 'running'] as const)('recovers a stale %s task as failed and writes it back', async (status) => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveHeyGemTaskState({
      workspace,
      sessionId: `session-stale-${status}`,
      taskId: `task-stale-${status}`,
      artifactId: 'render-stale',
      status,
      now: initialTime,
      runtimeOwnerId: 'old-runtime-owner',
    })
    const recoveryTime = new Date(Date.parse(initialTime) + HEYGEM_TASK_RECOVERY_WINDOW_MS + 1).toISOString()

    await expect(
      readHeyGemTaskState(workspace, `session-stale-${status}`, {
        now: recoveryTime,
        runtimeOwnerId: 'new-runtime-owner',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      artifactId: 'render-stale',
      createdAt: initialTime,
      updatedAt: recoveryTime,
      error: {
        code: 'task_interrupted',
        message: '数字人生成曾被异常中断，请重新发起生成。',
      },
    })

    const persisted = JSON.parse(
      await fs.readFile(taskPath(workspace.artifactsPath, `session-stale-${status}`), 'utf8'),
    )
    expect(persisted).toMatchObject({ status: 'failed', error: { code: 'task_interrupted' } })
    expect(persisted).not.toHaveProperty('runtimeOwnerId')
  })

  it('does not recover an active task owned by the current runtime instance even after a year', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const unregister = registerActiveHeyGemTask(workspace, 'session-current-owner', 'task-current-owner')
    await saveHeyGemTaskState({
      workspace,
      sessionId: 'session-current-owner',
      taskId: 'task-current-owner',
      status: 'running',
      now: initialTime,
    })

    try {
      await expect(
        readHeyGemTaskState(workspace, 'session-current-owner', {
          now: '2027-07-17T00:00:00.000Z',
        }),
      ).resolves.toMatchObject({
        status: 'running',
        runtimeOwnerId: expect.any(String),
        updatedAt: initialTime,
      })
    } finally {
      unregister()
    }
  })

  it('recovers a stale current-owner task after its active registration is disposed', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const unregister = registerActiveHeyGemTask(workspace, 'session-disposed', 'task-disposed')
    await saveHeyGemTaskState({
      workspace,
      sessionId: 'session-disposed',
      taskId: 'task-disposed',
      status: 'running',
      now: initialTime,
    })
    unregister()
    unregister()

    await expect(
      readHeyGemTaskState(workspace, 'session-disposed', {
        now: '2027-07-17T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'task_interrupted' },
    })
  })

  it('keeps a task active until every reference-counted registration is disposed', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const unregisterFirst = registerActiveHeyGemTask(workspace, 'session-shared', 'task-shared')
    const unregisterSecond = registerActiveHeyGemTask(workspace, 'session-shared', 'task-shared')
    await saveHeyGemTaskState({
      workspace,
      sessionId: 'session-shared',
      taskId: 'task-shared',
      status: 'running',
      now: initialTime,
    })
    unregisterFirst()

    await expect(
      readHeyGemTaskState(workspace, 'session-shared', {
        now: '2027-07-17T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'running' })

    unregisterSecond()
    await expect(
      readHeyGemTaskState(workspace, 'session-shared', {
        now: '2027-07-17T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'task_interrupted' },
    })
  })

  it('recovers a stale legacy task without runtime ownership', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const legacyPath = taskPath(workspace.artifactsPath, 'session-legacy')
    await fs.mkdir(path.dirname(legacyPath), { recursive: true })
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        taskId: 'task-legacy',
        projectId,
        sessionId: 'session-legacy',
        status: 'queued',
        createdAt: initialTime,
        updatedAt: initialTime,
      })}\n`,
      'utf8',
    )

    await expect(
      readHeyGemTaskState(workspace, 'session-legacy', {
        now: '2026-07-17T00:16:00.000Z',
        runtimeOwnerId: 'current-runtime-owner',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'task_interrupted' },
    })
  })

  it('keeps a running task inside the recovery window unchanged', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveHeyGemTaskState({
      workspace,
      sessionId: 'session-active',
      taskId: 'task-active',
      status: 'running',
      now: initialTime,
    })
    const withinWindow = new Date(Date.parse(initialTime) + HEYGEM_TASK_RECOVERY_WINDOW_MS).toISOString()

    const task = await readHeyGemTaskState(workspace, 'session-active', { now: withinWindow })
    expect(task).toMatchObject({
      status: 'running',
      updatedAt: initialTime,
    })
    expect(task).not.toHaveProperty('error')
  })

  it.each(['ready', 'failed'] as const)('never rewrites terminal %s tasks', async (status) => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const error = status === 'failed' ? { code: 'runtime_failed', message: '生成失败' } : undefined
    await saveHeyGemTaskState({
      workspace,
      sessionId: `session-terminal-${status}`,
      taskId: `task-terminal-${status}`,
      status,
      error,
      now: initialTime,
    })
    const renameSpy = vi.spyOn(fs, 'rename')

    const task = await readHeyGemTaskState(workspace, `session-terminal-${status}`, {
      now: '2027-07-17T00:00:00.000Z',
    })
    expect(task).toMatchObject({ status, updatedAt: initialTime })
    if (error) expect(task).toMatchObject({ error })
    else expect(task).not.toHaveProperty('error')
    expect(task).not.toHaveProperty('runtimeOwnerId')
    expect(renameSpy).not.toHaveBeenCalled()
  })

  it('returns a stable typed error for corrupt JSON without replacing the file', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const corruptPath = taskPath(workspace.artifactsPath, 'session-corrupt')
    await fs.mkdir(path.dirname(corruptPath), { recursive: true })
    await fs.writeFile(corruptPath, '{not-json', 'utf8')

    const read = readHeyGemTaskState(workspace, 'session-corrupt', { now: initialTime })
    await expect(read).rejects.toBeInstanceOf(HeyGemTaskStateError)
    await expect(readHeyGemTaskState(workspace, 'session-corrupt', { now: initialTime })).rejects.toMatchObject({
      code: 'task_state_corrupt',
      message: 'HeyGem 任务状态文件已损坏，无法恢复任务状态。',
    })
    await expect(fs.readFile(corruptPath, 'utf8')).resolves.toBe('{not-json')
  })

  it.each([
    ['JSON null', 'null'],
    ['null error', JSON.stringify({
      taskId: 'task-null-error',
      projectId,
      sessionId: 'session-invalid-shape',
      status: 'failed',
      error: null,
      createdAt: initialTime,
      updatedAt: initialTime,
    })],
  ])('returns task_state_corrupt for %s without replacing the file', async (_label, raw) => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const invalidPath = taskPath(workspace.artifactsPath, 'session-invalid-shape')
    await fs.mkdir(path.dirname(invalidPath), { recursive: true })
    await fs.writeFile(invalidPath, raw, 'utf8')

    await expect(readHeyGemTaskState(workspace, 'session-invalid-shape', { now: initialTime })).rejects.toMatchObject({
      code: 'task_state_corrupt',
    })
    await expect(fs.readFile(invalidPath, 'utf8')).resolves.toBe(raw)
  })
})

function taskPath(artifactsPath: string, sessionId: string) {
  return path.join(artifactsPath, 'render', `.heygem-task-${sessionId}.json`)
}
