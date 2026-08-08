import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace } from './workspace-manager'

const projectId = 'test-workspace-isolation'
const workspaceRoot = path.join(process.cwd(), 'data', 'workspaces', projectId)

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true })
})

describe('ensureProjectWorkspace', () => {
  it('creates isolated artifact and session directories for a project feature', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')

    expect(workspace.workspaceId).toBe(projectId)
    expect(workspace.projectId).toBe(projectId)
    expect(workspace.featureType).toBe('digital-human')
    expect(workspace.artifactsPath).toBe(path.join(workspaceRoot, 'artifacts'))
    expect(workspace.agentSessionsPath).toBe(path.join(workspaceRoot, 'sessions', 'agents'))

    await expect(fs.stat(workspace.artifactsPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    })
    await expect(fs.stat(workspace.featureSessionPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    })
    await expect(fs.stat(workspace.agentSessionsPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    })
  })
})
