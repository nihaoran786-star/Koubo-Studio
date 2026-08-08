import { NextResponse } from 'next/server'
import { WorkspaceGuardError, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { getBrowserPublishReadiness } from './browser-publish-adapter'
import { runPublishAgent, type RunPublishAgentResult } from './publish-agent-service'

interface PublishAgentRequestBody {
  sessionId?: unknown
  input?: unknown
}

export async function handlePublishAgentGet(options: { projectId: string }) {
  try {
    assertSafeSegment(options.projectId, 'projectId')
    return NextResponse.json(getBrowserPublishReadiness(), { status: 200 })
  } catch (error) {
    return guardError(error)
  }
}

export async function handlePublishAgentPost(
  request: Request,
  options: {
    projectId: string
    runAgent?: (input: { projectId: string; sessionId: string; input: unknown }) => Promise<RunPublishAgentResult>
  },
) {
  try {
    const body = (await request.json()) as PublishAgentRequestBody
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return invalidRequest('invalid_session_id', 'sessionId 不能为空')
    }
    const result = await (options.runAgent ?? runPublishAgent)({
      projectId: options.projectId,
      sessionId: assertSafeSegment(body.sessionId, 'sessionId'),
      input: body.input,
    })
    return NextResponse.json(result, { status: result.status === 'ready' ? 200 : result.status === 'invalid_request' ? 400 : 500 })
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return guardError(error)
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({
      status: 'publish_error',
      source: 'api',
      error: { code: 'unexpected_error', message },
    }, { status: 500 })
  }
}

export async function handlePublishAgentPut(_request?: Request, _options?: { projectId: string }) {
  return browserPendingResponse()
}

export async function handlePublishAgentPatch(_request?: Request, _options?: { projectId: string }) {
  return browserPendingResponse()
}

function browserPendingResponse() {
  return NextResponse.json({
    status: 'manual_required',
    source: 'visible_browser',
    error: {
      code: 'browser_automation_not_connected',
      message: '旧发布状态轮询和重试已移除；请先准备本地发布包，浏览器自动填写将在用户监督登录后接入。',
    },
  }, { status: 409 })
}

function invalidRequest(code: string, message: string) {
  return NextResponse.json({ status: 'invalid_request', source: 'api', error: { code, message } }, { status: 400 })
}

function guardError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return invalidRequest('workspace_guard', message)
}
