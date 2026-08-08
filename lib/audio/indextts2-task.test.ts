import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import {
  INDEXTTS2_TASK_RECOVERY_WINDOW_MS,
  IndexTTS2TaskStateError,
  readIndexTTS2TaskState,
  registerActiveIndexTTS2Task,
  saveIndexTTS2TaskState,
} from './indextts2-task'

const projectId = 'test-indextts2-task'
const initialTime = '2026-07-17T00:00:00.000Z'

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('IndexTTS2 task state', () => {
  it('persists transitions while retaining the original creation time', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const queued = await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'voice-session',
      taskId: 'audio-001',
      status: 'queued',
      now: '2026-07-15T10:00:00.000Z',
    })
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'voice-session',
      taskId: 'audio-001',
      artifactId: 'audio-001',
      status: 'failed',
      error: { code: 'runtime_missing', message: 'runtime 不可用' },
      createdAt: queued.createdAt,
      now: '2026-07-15T10:01:00.000Z',
    })

    await expect(readIndexTTS2TaskState(workspace, 'voice-session')).resolves.toEqual({
      taskId: 'audio-001',
      projectId,
      sessionId: 'voice-session',
      status: 'failed',
      artifactId: 'audio-001',
      error: { code: 'runtime_missing', message: 'runtime 不可用' },
      createdAt: '2026-07-15T10:00:00.000Z',
      updatedAt: '2026-07-15T10:01:00.000Z',
    })
  })

  it('writes through a unique same-directory temp file and atomically renames it', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renameSpy = vi.spyOn(fs, 'rename')

    await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'session-atomic',
      taskId: 'task-atomic',
      status: 'queued',
      now: initialTime,
    })

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [temporaryPath, finalPath] = renameSpy.mock.calls[0] as [string, string]
    expect(path.dirname(temporaryPath)).toBe(path.dirname(finalPath))
    expect(path.basename(temporaryPath)).toMatch(/^\.\.indextts2-task-session-atomic\.json\.\d+\..+\.tmp$/)
    expect(finalPath).toBe(taskPath(workspace.artifactsPath, 'session-atomic'))
    await expect(fs.stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes its temp file when atomic rename fails', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('rename failed'), { code: 'EIO' }))

    await expect(
      saveIndexTTS2TaskState({
        workspace,
        sessionId: 'session-cleanup',
        taskId: 'task-cleanup',
        status: 'running',
        now: initialTime,
      }),
    ).rejects.toThrow('rename failed')

    const audioDirectory = path.join(workspace.artifactsPath, 'audio')
    const entries = await fs.readdir(audioDirectory)
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    await expect(fs.stat(taskPath(workspace.artifactsPath, 'session-cleanup'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not reuse temp names across concurrent writes', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renameSpy = vi.spyOn(fs, 'rename')

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saveIndexTTS2TaskState({
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
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: `session-stale-${status}`,
      taskId: `task-stale-${status}`,
      artifactId: 'audio-stale',
      status,
      now: initialTime,
      runtimeOwnerId: 'old-runtime-owner',
    })
    const recoveryTime = new Date(Date.parse(initialTime) + INDEXTTS2_TASK_RECOVERY_WINDOW_MS + 1).toISOString()

    await expect(
      readIndexTTS2TaskState(workspace, `session-stale-${status}`, {
        now: recoveryTime,
        runtimeOwnerId: 'new-runtime-owner',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      artifactId: 'audio-stale',
      createdAt: initialTime,
      updatedAt: recoveryTime,
      error: {
        code: 'task_interrupted',
        message: '声音生成曾被异常中断，请重新发起生成。',
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
    const unregister = registerActiveIndexTTS2Task(workspace, 'session-current-owner', 'task-current-owner')
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'session-current-owner',
      taskId: 'task-current-owner',
      status: 'running',
      now: initialTime,
    })

    await expect(
      readIndexTTS2TaskState(workspace, 'session-current-owner', {
        now: '2027-07-17T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      status: 'running',
      runtimeOwnerId: expect.any(String),
      updatedAt: initialTime,
    })
    unregister()
  })

  it('recovers a stale current-owner task after its active registration is disposed', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const unregister = registerActiveIndexTTS2Task(workspace, 'session-disposed', 'task-disposed')
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'session-disposed',
      taskId: 'task-disposed',
      status: 'running',
      now: initialTime,
    })
    unregister()

    await expect(
      readIndexTTS2TaskState(workspace, 'session-disposed', {
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
      readIndexTTS2TaskState(workspace, 'session-legacy', {
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
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: 'session-active',
      taskId: 'task-active',
      status: 'running',
      now: initialTime,
      runtimeOwnerId: 'old-owner',
    })
    const withinWindow = new Date(Date.parse(initialTime) + INDEXTTS2_TASK_RECOVERY_WINDOW_MS).toISOString()

    const task = await readIndexTTS2TaskState(workspace, 'session-active', {
      now: withinWindow,
      runtimeOwnerId: 'new-owner',
    })
    expect(task).toMatchObject({ status: 'running', updatedAt: initialTime })
    expect(task).not.toHaveProperty('error')
  })

  it.each(['ready', 'failed'] as const)('never rewrites terminal %s tasks', async (status) => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const error = status === 'failed' ? { code: 'runtime_failed', message: '生成失败' } : undefined
    await saveIndexTTS2TaskState({
      workspace,
      sessionId: `session-terminal-${status}`,
      taskId: `task-terminal-${status}`,
      status,
      error,
      now: initialTime,
    })
    const renameSpy = vi.spyOn(fs, 'rename')

    const task = await readIndexTTS2TaskState(workspace, `session-terminal-${status}`, {
      now: '2027-07-17T00:00:00.000Z',
    })
    expect(task).toMatchObject({ status, updatedAt: initialTime })
    expect(task).not.toHaveProperty('runtimeOwnerId')
    expect(renameSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['corrupt JSON', '{not-json'],
    ['JSON null', 'null'],
    [
      'invalid shape',
      JSON.stringify({
        taskId: 'task-invalid',
        projectId,
        sessionId: 'session-corrupt',
        status: 'running',
        createdAt: initialTime,
      }),
    ],
    [
      'invalid date',
      JSON.stringify({
        taskId: 'task-invalid-date',
        projectId,
        sessionId: 'session-corrupt',
        status: 'running',
        createdAt: initialTime,
        updatedAt: 'not-a-date',
      }),
    ],
    [
      'null error',
      JSON.stringify({
        taskId: 'task-null-error',
        projectId,
        sessionId: 'session-corrupt',
        status: 'failed',
        error: null,
        createdAt: initialTime,
        updatedAt: initialTime,
      }),
    ],
  ])('returns a stable typed error for %s without replacing the file', async (_label, raw) => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const corruptPath = taskPath(workspace.artifactsPath, 'session-corrupt')
    await fs.mkdir(path.dirname(corruptPath), { recursive: true })
    await fs.writeFile(corruptPath, raw, 'utf8')

    await expect(readIndexTTS2TaskState(workspace, 'session-corrupt', { now: initialTime })).rejects.toBeInstanceOf(
      IndexTTS2TaskStateError,
    )
    await expect(readIndexTTS2TaskState(workspace, 'session-corrupt', { now: initialTime })).rejects.toMatchObject({
      code: 'task_state_corrupt',
    })
    await expect(fs.readFile(corruptPath, 'utf8')).resolves.toBe(raw)
  })
})

function taskPath(artifactsPath: string, sessionId: string) {
  return path.join(artifactsPath, 'audio', `.indextts2-task-${sessionId}.json`)
}
