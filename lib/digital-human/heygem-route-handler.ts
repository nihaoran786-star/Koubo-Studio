import { NextResponse } from 'next/server'
import { WorkspaceGuardError, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import {
  generateHeyGemRender,
  getHeyGemTask,
  type GenerateHeyGemRenderResult,
  type GetHeyGemTaskResult,
} from './heygem-service'

interface HeyGemRequestBody {
  sessionId?: unknown
  input?: unknown
}

export async function handleHeyGemGet(
  request: Request,
  options: {
    projectId: string
    getTask?: (input: { projectId: string; sessionId: string }) => Promise<GetHeyGemTaskResult>
  },
) {
  try {
    const sessionIdValue = new URL(request.url).searchParams.get('sessionId')
    if (!sessionIdValue) return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    const sessionId = assertSafeSegment(sessionIdValue, 'sessionId')
    const result = await (options.getTask ?? getHeyGemTask)({
      projectId: options.projectId,
      sessionId,
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return invalidRequest('workspace_guard', error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'adapter_error',
        source: 'api',
        error: { code: 'unexpected_error', message },
      },
      { status: 500 },
    )
  }
}

export async function handleHeyGemPost(
  request: Request,
  options: {
    projectId: string
    generateRender?: (input: {
      projectId: string
      sessionId: string
      input: unknown
    }) => Promise<GenerateHeyGemRenderResult>
  },
) {
  try {
    const body = (await request.json()) as HeyGemRequestBody

    if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
      return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    }

    const sessionId = assertSafeSegment(body.sessionId, 'sessionId')
    const result = await (options.generateRender ?? generateHeyGemRender)({
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
        status: 'adapter_error',
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

function statusCodeForResult(result: GenerateHeyGemRenderResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}
