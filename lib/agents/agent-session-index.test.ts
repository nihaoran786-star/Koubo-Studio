import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { createAgentSessionMetadata } from './agent-session'
import {
  AgentSessionIndexError,
  appendAgentSessionMetadata,
  listAgentSessions,
  resolveAgentSessionIndexPath,
} from './agent-session-index'

const projectId = 'test-agent-session-index'
const workspaceRoot = path.join(process.cwd(), 'data', 'workspaces', projectId)

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true })
})

describe('agent session index', () => {
  it('persists and queries sessions by role, parent session, and artifact', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const session = createAgentSessionMetadata({
      sessionId: 'session-child',
      sessionKind: 'subagent',
      parentSessionId: 'session-main',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.rootPath,
      agentRole: 'post_production',
      artifactId: 'render-001',
    })

    await appendAgentSessionMetadata(workspace, session)

    expect(resolveAgentSessionIndexPath(workspace)).toBe(
      path.join(workspace.agentSessionsPath, 'index.json'),
    )
    await expect(fs.stat(resolveAgentSessionIndexPath(workspace))).resolves.toBeTruthy()
    await expect(listAgentSessions(workspace, { agentRole: 'post_production' })).resolves.toEqual([
      session,
    ])
    await expect(listAgentSessions(workspace, { parentSessionId: 'session-main' })).resolves.toEqual([
      session,
    ])
    await expect(listAgentSessions(workspace, { artifactId: 'render-001' })).resolves.toEqual([
      session,
    ])
    await expect(listAgentSessions(workspace, { agentRole: 'publish' })).resolves.toEqual([])
  })

  it('returns index_error when the session index is corrupted', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await fs.writeFile(resolveAgentSessionIndexPath(workspace), '{bad json', 'utf8')

    await expect(listAgentSessions(workspace)).rejects.toMatchObject({
      code: 'index_error',
      source: 'agent_session_index',
    } satisfies Partial<AgentSessionIndexError>)
  })
})
