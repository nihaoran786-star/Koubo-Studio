import { NextResponse } from 'next/server'
import { assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import {
  createOpenChatCutProject,
  getOpenChatCutProject,
  getOpenChatCutRuntime,
  launchOpenChatCutRuntime,
  prepareOpenChatCutRuntime,
  runOpenChatCutSession,
} from './integration-service'

export async function handleOpenChatCutGet() {
  return NextResponse.json(await getOpenChatCutRuntime())
}

export async function handleOpenChatCutPost(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; target?: unknown }
    if (body.action === 'prepare') return NextResponse.json(await prepareOpenChatCutRuntime())
    if (body.action === 'launch' && (body.target === 'installer' || body.target === 'app')) {
      return NextResponse.json(await launchOpenChatCutRuntime(body.target))
    }
    return invalid('invalid_action', '运行环境操作无效。')
  } catch {
    return invalid('invalid_json', '请求格式无效。')
  }
}

export async function handleOpenChatCutProjectPost(request: Request, projectId: string) {
  try {
    const safeProjectId = assertSafeSegment(projectId, 'projectId')
    const body = await request.json() as Record<string, unknown>
    if (body.action === 'create') return NextResponse.json(await createOpenChatCutProject(safeProjectId))
    if (
      body.action === 'import' ||
      body.action === 'begin' ||
      body.action === 'status' ||
      body.action === 'review' ||
      body.action === 'discard' ||
      body.action === 'export'
    ) {
      if (typeof body.openChatCutProjectId !== 'string') return invalid('invalid_project', '专业剪辑项目无效。')
      return NextResponse.json(await runOpenChatCutSession({
        projectId: safeProjectId,
        action: body.action,
        openChatCutProjectId: body.openChatCutProjectId,
        ...(typeof body.editSessionId === 'string' ? { editSessionId: body.editSessionId } : {}),
        ...(typeof body.request === 'string' ? { request: body.request } : {}),
      }))
    }
    return invalid('invalid_action', '专业剪辑操作无效。')
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return invalid('workspace_guard', error.message)
    return invalid('invalid_json', '请求格式无效。')
  }
}

export async function handleOpenChatCutProjectGet(projectId: string) {
  try {
    return NextResponse.json(await getOpenChatCutProject(assertSafeSegment(projectId, 'projectId')))
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return invalid('workspace_guard', error.message)
    return invalid('invalid_project', '项目参数无效。')
  }
}

function invalid(code: string, message: string) {
  return NextResponse.json({ status: 'error', source: 'openchatcut', error: { code, message } }, { status: 400 })
}
