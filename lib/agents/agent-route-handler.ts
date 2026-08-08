import { NextResponse } from 'next/server'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import {
  getAgentSessionDetail,
  type AgentSessionDetailResult,
} from './agent-session-detail'
import {
  listAgentSessionTimeline,
  type AgentSessionTimelineResult,
} from './agent-session-timeline'

export async function handleAgentGet(
  request: Request,
  options: {
    projectId: string
    getSessionDetail?: typeof getAgentSessionDetail
    listSessionTimeline?: typeof listAgentSessionTimeline
  },
) {
  try {
    const url = new URL(request.url)
    const view = url.searchParams.get('view') ?? ''
    if (view === 'timeline') {
      const result = await (options.listSessionTimeline ?? listAgentSessionTimeline)({
        projectId: options.projectId,
      })
      return NextResponse.json(result, { status: statusCodeForSessionTimeline(result) })
    }

    if (view.trim()) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'api',
          error: {
            code: 'invalid_view',
            message: '不支持的 agent 视图。',
          },
        },
        { status: 400 },
      )
    }

    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!sessionId.trim()) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'api',
          error: {
            code: 'missing_session_id',
            message: 'sessionId 不能为空',
          },
        },
        { status: 400 },
      )
    }

    const result = await (options.getSessionDetail ?? getAgentSessionDetail)({
      projectId: options.projectId,
      sessionId: sessionId.trim(),
    })
    return NextResponse.json(result, { status: statusCodeForSessionDetail(result) })
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'workspace',
          error: {
            code: 'workspace_guard',
            message: error.message,
          },
        },
        { status: 400 },
      )
    }

    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'agent_error',
        source: 'api',
        error: {
          code: 'unexpected_error',
          message,
        },
      },
      { status: 500 },
    )
  }
}

function statusCodeForSessionDetail(result: AgentSessionDetailResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}

function statusCodeForSessionTimeline(result: AgentSessionTimelineResult) {
  if (result.status === 'ok') return 200
  return 500
}
