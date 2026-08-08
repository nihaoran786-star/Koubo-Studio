import { NextResponse } from 'next/server'
import {
  approveScriptArtifactForProject,
  runScriptAgent,
  type ApproveScriptArtifactResult,
  type RunScriptAgentInput,
  type RunScriptAgentResult,
  type ScriptAgentTurnType,
} from './script-agent-service'
import type { ScriptApprovalStatus } from '@/lib/artifacts/script-artifact'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'

interface ScriptAgentRequestBody {
  message?: unknown
  promptName?: unknown
  turnType?: unknown
  approvalStatus?: unknown
  artifactId?: unknown
}

interface ScriptApprovalRequestBody {
  artifactId?: unknown
}

export async function handleScriptAgentPost(
  request: Request,
  options: {
    projectId: string
    runAgent?: (input: RunScriptAgentInput) => Promise<RunScriptAgentResult>
  },
) {
  try {
    const body = (await request.json()) as ScriptAgentRequestBody

    if (typeof body.message !== 'string' || body.message.trim().length === 0) {
      return invalidRequest('empty_message', 'message 不能为空')
    }

    if (body.message.length > 8000) {
      return invalidRequest('message_too_long', 'message 不能超过 8000 个字符')
    }

    if (!isApprovalStatus(body.approvalStatus)) {
      return invalidRequest('invalid_approval_status', 'approvalStatus 只能是 draft 或 approved')
    }

    const turnType = parseTurnType(body.turnType)
    if (turnType.status === 'invalid') {
      return invalidRequest(turnType.code, turnType.message)
    }

    const result = await (options.runAgent ?? runScriptAgent)({
      projectId: options.projectId,
      message: body.message,
      turnType: turnType.value,
      promptName: typeof body.promptName === 'string' ? body.promptName : undefined,
      approvalStatus: body.approvalStatus,
      artifactId: typeof body.artifactId === 'string' && body.artifactId.trim() ? body.artifactId.trim() : undefined,
    })

    return NextResponse.json(result, { status: statusCodeForResult(result) })
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

export async function handleScriptAgentPatch(
  request: Request,
  options: {
    projectId: string
    approveScript?: typeof approveScriptArtifactForProject
  },
) {
  try {
    const body = (await request.json()) as ScriptApprovalRequestBody
    if (typeof body.artifactId !== 'string' || body.artifactId.trim().length === 0) {
      return invalidRequest('missing_artifact_id', 'artifactId 不能为空')
    }

    const result = await (options.approveScript ?? approveScriptArtifactForProject)({
      projectId: options.projectId,
      artifactId: body.artifactId.trim(),
    })

    return NextResponse.json(result, { status: statusCodeForApprovalResult(result) })
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
        status: 'artifact_error',
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

function isApprovalStatus(value: unknown): value is ScriptApprovalStatus {
  return value === 'draft' || value === 'approved'
}

function parseTurnType(value: unknown):
  | { status: 'ok'; value: ScriptAgentTurnType }
  | { status: 'invalid'; code: string; message: string } {
  if (value === undefined || value === null) return { status: 'ok', value: 'generate_artifact' }
  if (value === 'clarify' || value === 'generate_artifact') return { status: 'ok', value }
  return { status: 'invalid', code: 'invalid_turn_type', message: 'turnType 只能是 clarify 或 generate_artifact' }
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

function statusCodeForResult(result: RunScriptAgentResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'script_parse_error') return 422
  return 500
}

function statusCodeForApprovalResult(result: ApproveScriptArtifactResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}
