import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot } from '@/lib/workspaces/workspace-guard'
import type { AgentRole, AgentSessionMetadata } from './agent-session'

interface AgentSessionIndexFile {
  version: 1
  sessions: AgentSessionMetadata[]
}

export class AgentSessionIndexError extends Error {
  code = 'index_error' as const
  source = 'agent_session_index' as const

  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionIndexError'
  }
}

export function resolveAgentSessionIndexPath(workspace: ProjectWorkspace) {
  return assertInsideRoot(
    workspace.agentSessionsPath,
    path.join(workspace.agentSessionsPath, 'index.json'),
  )
}

export async function appendAgentSessionMetadata(
  workspace: ProjectWorkspace,
  session: AgentSessionMetadata,
) {
  const index = await readAgentSessionIndex(workspace)
  const nextSessions = [
    ...index.sessions.filter((item) => item.sessionId !== session.sessionId),
    session,
  ]
  await writeAgentSessionIndex(workspace, { version: 1, sessions: nextSessions })
  return session
}

export async function listAgentSessions(
  workspace: ProjectWorkspace,
  filter: {
    sessionId?: string
    agentRole?: AgentRole
    parentSessionId?: string
    artifactId?: string
  } = {},
) {
  const index = await readAgentSessionIndex(workspace)
  return index.sessions.filter((session) => {
    if (filter.sessionId && session.sessionId !== filter.sessionId) return false
    if (filter.agentRole && session.agentRole !== filter.agentRole) return false
    if (filter.parentSessionId && session.parentSessionId !== filter.parentSessionId) return false
    if (filter.artifactId && session.artifactId !== filter.artifactId) return false
    return true
  })
}

async function readAgentSessionIndex(workspace: ProjectWorkspace): Promise<AgentSessionIndexFile> {
  const indexPath = resolveAgentSessionIndexPath(workspace)
  try {
    const raw = await fs.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AgentSessionIndexFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      throw new AgentSessionIndexError('agent session index 格式无效')
    }
    return { version: 1, sessions: parsed.sessions }
  } catch (error) {
    if (isMissingFile(error)) {
      return { version: 1, sessions: [] }
    }
    if (error instanceof AgentSessionIndexError) {
      throw error
    }
    throw new AgentSessionIndexError('agent session index 无法读取或解析')
  }
}

async function writeAgentSessionIndex(workspace: ProjectWorkspace, index: AgentSessionIndexFile) {
  const indexPath = resolveAgentSessionIndexPath(workspace)
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
