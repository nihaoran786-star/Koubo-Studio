import { NextResponse } from 'next/server'
import { WorkspaceGuardError, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import {
  generateIndexTTS2Audio,
  getIndexTTS2Task,
  type GenerateIndexTTS2AudioResult,
  type GetIndexTTS2TaskResult,
} from './indextts2-service'

interface IndexTTS2RequestBody {
  sessionId?: unknown
  parameters?: unknown
}

export async function handleIndexTTS2Get(
  request: Request,
  options: {
    projectId: string
    getTask?: (input: { projectId: string; sessionId: string }) => Promise<GetIndexTTS2TaskResult>
  },
) {
  try {
    const sessionIdValue = new URL(request.url).searchParams.get('sessionId')
    if (!sessionIdValue) return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    const sessionId = assertSafeSegment(sessionIdValue, 'sessionId')
    const result = await (options.getTask ?? getIndexTTS2Task)({
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

export async function handleIndexTTS2Post(
  request: Request,
  options: {
    projectId: string
    generateAudio?: (input: {
      projectId: string
      sessionId: string
      parameters: unknown
    }) => Promise<GenerateIndexTTS2AudioResult>
  },
) {
  try {
    const body = (await request.json()) as IndexTTS2RequestBody

    if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
      return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    }

    const sessionId = assertSafeSegment(body.sessionId, 'sessionId')
    const result = await (options.generateAudio ?? generateIndexTTS2Audio)({
      projectId: options.projectId,
      sessionId,
      parameters: body.parameters,
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

function statusCodeForResult(result: GenerateIndexTTS2AudioResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}
