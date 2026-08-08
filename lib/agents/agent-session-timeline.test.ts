import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendArtifactRecord } from '@/lib/artifacts/artifact-index'
import { createArtifactRecord } from '@/lib/artifacts/artifact-manager'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { createAgentSessionMetadata } from './agent-session'
import { appendAgentSessionMetadata } from './agent-session-index'
import { listAgentSessionTimeline } from './agent-session-timeline'

const projectId = 'test-agent-session-timeline'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('listAgentSessionTimeline', () => {
  it('lists project sessions with their artifact records newest first', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
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
        now: '2026-06-11T01:00:00.000Z',
      }),
    )
    await appendArtifactRecord(
      workspace,
      createArtifactRecord({
        workspace,
        artifactId: 'audio-001',
        artifactType: 'audio',
        relativePath: 'audio-001.wav',
        sessionId: 'voice-session-001',
        agentRole: 'voice',
        status: 'ready',
        now: '2026-06-11T02:00:00.000Z',
      }),
    )
    await appendArtifactRecord(
      workspace,
      createArtifactRecord({
        workspace,
        artifactId: 'render-001',
        artifactType: 'render',
        relativePath: 'render-001.mp4',
        sessionId: 'avatar-session-001',
        agentRole: 'digital_human',
        status: 'ready',
        now: '2026-06-11T03:00:00.000Z',
      }),
    )

    for (const session of [
      createAgentSessionMetadata({
        sessionId: 'script-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'script',
        artifactId: 'script-001',
      }),
      createAgentSessionMetadata({
        sessionId: 'voice-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'voice',
        artifactId: 'audio-001',
      }),
      createAgentSessionMetadata({
        sessionId: 'avatar-session-001',
        sessionKind: 'main',
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'digital_human',
        artifactId: 'render-001',
      }),
    ]) {
      await appendAgentSessionMetadata(workspace, session)
    }

    await expect(listAgentSessionTimeline({ projectId })).resolves.toMatchObject({
      status: 'ok',
      source: 'agent_session_timeline',
      projectId,
      items: [
        {
          session: {
            sessionId: 'avatar-session-001',
            agentRole: 'digital_human',
            artifactId: 'render-001',
          },
          artifactRecord: {
            artifactId: 'render-001',
            artifactType: 'render',
            agentRole: 'digital_human',
          },
        },
        {
          session: {
            sessionId: 'voice-session-001',
            agentRole: 'voice',
            artifactId: 'audio-001',
          },
        },
        {
          session: {
            sessionId: 'script-session-001',
            agentRole: 'script',
            artifactId: 'script-001',
          },
        },
      ],
    })
  })
})
