import { NextResponse } from 'next/server'
import { handleAgentGet } from '@/lib/agents/agent-route-handler'
import { isFeatureType } from '@/lib/features/feature-registry'
import { runModelAgent } from '@/lib/agents/model-agent-service'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'

export const runtime = 'nodejs'

interface AgentRequestBody {
  featureType?: unknown
  message?: unknown
  promptName?: unknown
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleAgentGet(request, { projectId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await params
    const body = (await request.json()) as AgentRequestBody
    const featureType = body.featureType ?? 'digital-human'

    if (!isFeatureType(featureType)) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'api',
          error: {
            code: 'invalid_feature_type',
            message: '当前第一版只支持 digital-human 数字人视频模式',
          },
        },
        { status: 400 },
      )
    }

    if (typeof body.message !== 'string' || body.message.trim().length === 0) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'api',
          error: {
            code: 'empty_message',
            message: 'message 不能为空',
          },
        },
        { status: 400 },
      )
    }

    if (body.message.length > 8000) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: 'api',
          error: {
            code: 'message_too_long',
            message: 'message 不能超过 8000 个字符',
          },
        },
        { status: 400 },
      )
    }

    const result = await runModelAgent({
      projectId,
      featureType,
      message: body.message,
      promptName: typeof body.promptName === 'string' ? body.promptName : undefined,
    })

    return NextResponse.json(result, {
      status: result.status === 'ok' ? 200 : 500,
    })
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
