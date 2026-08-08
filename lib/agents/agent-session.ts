export type AgentSessionKind = 'main' | 'subagent' | 'automation' | 'review' | 'artifact_discussion'

export type AgentRole = 'script' | 'voice' | 'digital_human' | 'post_production' | 'publish' | 'reviewer'

export interface AgentSessionMetadata {
  sessionId: string
  sessionKind: AgentSessionKind
  parentSessionId?: string
  workspaceId: string
  workspacePath: string
  backend: 'local' | 'remote'
  remoteConnectionId?: string
  remoteHost?: string
  agentRole: AgentRole
  artifactId?: string
}

export function createAgentSessionMetadata(input: {
  sessionId: string
  sessionKind: AgentSessionKind
  parentSessionId?: string
  workspaceId: string
  workspacePath: string
  backend?: 'local' | 'remote'
  remoteConnectionId?: string
  remoteHost?: string
  agentRole: AgentRole
  artifactId?: string
}): AgentSessionMetadata {
  if (input.sessionKind === 'subagent' && !input.parentSessionId) {
    throw new Error('subagent session 必须包含 parentSessionId')
  }

  if (input.backend === 'remote' && !input.remoteConnectionId) {
    throw new Error('remote session 必须包含 remoteConnectionId')
  }

  return {
    sessionId: input.sessionId,
    sessionKind: input.sessionKind,
    parentSessionId: input.parentSessionId,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    backend: input.backend ?? 'local',
    remoteConnectionId: input.remoteConnectionId,
    remoteHost: input.remoteHost,
    agentRole: input.agentRole,
    artifactId: input.artifactId,
  }
}
