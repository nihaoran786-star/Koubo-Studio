import { describe, expect, it } from 'vitest'
import { createAgentSessionMetadata } from './agent-session'

describe('createAgentSessionMetadata', () => {
  it('keeps child agent session identity explicit and traceable', () => {
    const session = createAgentSessionMetadata({
      sessionId: 'session-child',
      sessionKind: 'subagent',
      parentSessionId: 'session-main',
      workspaceId: 'project-001',
      workspacePath: 'C:\\workspace\\project-001',
      agentRole: 'post_production',
      artifactId: 'render-001',
    })

    expect(session).toEqual({
      sessionId: 'session-child',
      sessionKind: 'subagent',
      parentSessionId: 'session-main',
      workspaceId: 'project-001',
      workspacePath: 'C:\\workspace\\project-001',
      backend: 'local',
      agentRole: 'post_production',
      artifactId: 'render-001',
    })
  })

  it('requires subagent sessions to have a parent session', () => {
    expect(() =>
      createAgentSessionMetadata({
        sessionId: 'session-child',
        sessionKind: 'subagent',
        workspaceId: 'project-001',
        workspacePath: 'C:\\workspace\\project-001',
        agentRole: 'script',
      }),
    ).toThrow('subagent session 必须包含 parentSessionId')
  })
})
