import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendArtifactRecord } from '@/lib/artifacts/artifact-index'
import { createArtifactRecord } from '@/lib/artifacts/artifact-manager'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { createAgentSessionMetadata } from './agent-session'
import {
  appendAgentSessionMetadata,
  resolveAgentSessionIndexPath,
} from './agent-session-index'
import { getAgentSessionDetail } from './agent-session-detail'

const projectId = 'test-agent-session-detail'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('getAgentSessionDetail', () => {
  it('returns script main session detail with its artifact record', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await appendAgentSessionMetadata(
      workspace,
      createAgentSessionMetadata({
        sessionId: 'script-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'script',
        artifactId: 'script-001',
      }),
    )
    await appendArtifactRecord(
      workspace,
      createArtifactRecord({
        workspace,
        artifactId: 'script-001',
        artifactType: 'script',
        relativePath: 'script-001.json',
        sessionId: 'script-session-001',
        agentRole: 'script',
        status: 'ready',
      }),
    )

    await expect(getAgentSessionDetail({ projectId, sessionId: 'script-session-001' })).resolves.toMatchObject({
      status: 'ok',
      source: 'agent_session_detail',
      session: {
        sessionKind: 'main',
        agentRole: 'script',
        artifactId: 'script-001',
      },
      artifactRecord: {
        artifactType: 'script',
        artifactId: 'script-001',
      },
    })
  })

  it('returns post-production subagent detail with its parent script session', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await seedSessionChain(workspace)

    await expect(getAgentSessionDetail({ projectId, sessionId: 'post-session-001' })).resolves.toMatchObject({
      status: 'ok',
      session: {
        sessionKind: 'subagent',
        parentSessionId: 'script-session-001',
        agentRole: 'post_production',
        artifactId: 'post-001',
      },
      parentSession: {
        sessionKind: 'main',
        agentRole: 'script',
        artifactId: 'script-001',
      },
      artifactRecord: {
        artifactType: 'post-production',
        artifactId: 'post-001',
      },
    })
  })

  it('returns publish subagent detail with its parent post-production session', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await seedSessionChain(workspace)

    await expect(getAgentSessionDetail({ projectId, sessionId: 'publish-session-001' })).resolves.toMatchObject({
      status: 'ok',
      session: {
        sessionKind: 'subagent',
        parentSessionId: 'post-session-001',
        agentRole: 'publish',
        artifactId: 'publish-001',
      },
      parentSession: {
        sessionKind: 'subagent',
        agentRole: 'post_production',
        artifactId: 'post-001',
      },
      artifactRecord: {
        artifactType: 'publish-package',
        artifactId: 'publish-001',
      },
    })
  })

  it('returns stable errors for missing and corrupted sessions', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')

    await expect(getAgentSessionDetail({ projectId, sessionId: 'missing-session' })).resolves.toMatchObject({
      status: 'invalid_request',
      error: {
        code: 'session_not_found',
      },
    })

    await fs.writeFile(resolveAgentSessionIndexPath(workspace), '{bad json', 'utf8')
    await expect(getAgentSessionDetail({ projectId, sessionId: 'missing-session' })).resolves.toMatchObject({
      status: 'index_error',
      error: {
        code: 'index_error',
      },
    })
  })

  it('rejects session metadata that points at another workspace', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await appendAgentSessionMetadata(
      workspace,
      createAgentSessionMetadata({
        sessionId: 'foreign-session',
        sessionKind: 'main',
        workspaceId: 'workspace-other',
        workspacePath: workspace.rootPath,
        agentRole: 'script',
      }),
    )

    await expect(getAgentSessionDetail({ projectId, sessionId: 'foreign-session' })).resolves.toMatchObject({
      status: 'invalid_request',
      error: {
        code: 'workspace_mismatch',
      },
    })
  })
})

async function seedSessionChain(workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>) {
  const sessions = [
    createAgentSessionMetadata({
      sessionId: 'script-session-001',
      sessionKind: 'main',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.rootPath,
      agentRole: 'script',
      artifactId: 'script-001',
    }),
    createAgentSessionMetadata({
      sessionId: 'post-session-001',
      sessionKind: 'subagent',
      parentSessionId: 'script-session-001',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.rootPath,
      agentRole: 'post_production',
      artifactId: 'post-001',
    }),
    createAgentSessionMetadata({
      sessionId: 'publish-session-001',
      sessionKind: 'subagent',
      parentSessionId: 'post-session-001',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.rootPath,
      agentRole: 'publish',
      artifactId: 'publish-001',
    }),
  ]

  for (const session of sessions) {
    await appendAgentSessionMetadata(workspace, session)
  }

  await appendArtifactRecord(
    workspace,
    createArtifactRecord({
      workspace,
      artifactId: 'script-001',
      artifactType: 'script',
      relativePath: 'script-001.json',
      sessionId: 'script-session-001',
      agentRole: 'script',
      status: 'ready',
    }),
  )
  await appendArtifactRecord(
    workspace,
    createArtifactRecord({
      workspace,
      artifactId: 'post-001',
      artifactType: 'post-production',
      relativePath: 'post-001.json',
      sessionId: 'post-session-001',
      agentRole: 'post_production',
      status: 'ready',
    }),
  )
  await appendArtifactRecord(
    workspace,
    createArtifactRecord({
      workspace,
      artifactId: 'publish-001',
      artifactType: 'publish-package',
      relativePath: 'publish-001.json',
      sessionId: 'publish-session-001',
      agentRole: 'publish',
      status: 'ready',
    }),
  )
}
