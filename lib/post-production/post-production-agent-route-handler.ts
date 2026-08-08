import { NextResponse } from 'next/server'
import { WorkspaceGuardError, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import {
  getPostProductionTask,
  runPostProductionAgent,
  type GetPostProductionTaskResult,
  type RunPostProductionAgentResult,
} from './post-production-agent-service'

interface PostProductionAgentRequestBody {
  sessionId?: unknown
  input?: unknown
}

export async function handlePostProductionAgentGet(
  request: Request,
  options: {
    projectId: string
    getTask?: (input: { projectId: string; sessionId: string }) => Promise<GetPostProductionTaskResult>
  },
) {
  try {
    const value = new URL(request.url).searchParams.get('sessionId')
    if (!value) return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    const sessionId = assertSafeSegment(value, 'sessionId')
    const result = await (options.getTask ?? getPostProductionTask)({ projectId: options.projectId, sessionId })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return invalidRequest('workspace_guard', error.message)
    return NextResponse.json({
      status: 'skill_error', source: 'api',
      error: { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) },
    }, { status: 500 })
  }
}

export async function handlePostProductionAgentPost(
  request: Request,
  options: {
    projectId: string
    runAgent?: (input: {
      projectId: string
      sessionId: string
      input: unknown
    }) => Promise<RunPostProductionAgentResult>
  },
) {
  try {
    const body = (await request.json()) as PostProductionAgentRequestBody

    if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
      return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    }

    const sessionId = assertSafeSegment(body.sessionId, 'sessionId')
    const result = await (options.runAgent ?? runPostProductionAgent)({
      projectId: options.projectId,
      sessionId,
      input: body.input,
    })

    return NextResponse.json(result, { status: statusCodeForResult(result) })
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return invalidRequest('workspace_guard', error.message)
    }

    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'skill_error',
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

function invalidRequest(code: string, message: string) {
  return NextResponse.json(
    {
      status: 'invalid_request',
      source: 'api',
      error: {
        code,
        message,
      },
    },
    { status: 400 },
  )
}

function statusCodeForResult(result: RunPostProductionAgentResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}
