import { NextResponse } from 'next/server'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { createProjectState, getProjectState, listProjectStates, mutateProjectState, ProjectStateError } from './project-state-service'
import type { ProjectStateMutation, ProjectStateResult } from './project-state-types'
import type { ScriptDraft } from '@/lib/workspace'

export async function handleProjectsGet() {
  try {
    const { projects, issues } = await listProjectStates()
    return NextResponse.json({ status: issues.length ? 'degraded' : 'ok', source: 'project_state', projects, issues })
  } catch (error) {
    return projectError(error)
  }
}

export async function handleProjectsPost(request: Request) {
  try {
    const body = await request.json() as { projectId?: unknown; script?: unknown }
    if (!body.script || typeof body.script !== 'object') return invalid('invalid_script', '创建项目时必须提供初始文案状态。')
    const project = await createProjectState({
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      script: body.script as ScriptDraft,
    })
    return NextResponse.json({ status: 'ok', source: 'project_state', project }, { status: 201 })
  } catch (error) {
    return projectError(error)
  }
}

export async function handleProjectStateGet(options: { projectId: string }) {
  try {
    return NextResponse.json({ status: 'ok', source: 'project_state', project: await getProjectState(options.projectId) })
  } catch (error) {
    return projectError(error)
  }
}

export async function handleProjectStatePatch(request: Request, options: { projectId: string }) {
  try {
    const mutation = await request.json() as ProjectStateMutation
    if (!mutation || typeof mutation !== 'object' || typeof mutation.operation !== 'string') return invalid('invalid_mutation', '项目更新指令无效。')
    const project = await mutateProjectState(options.projectId, mutation)
    return NextResponse.json({ status: 'ok', source: 'project_state', project })
  } catch (error) {
    return projectError(error)
  }
}

function projectError(error: unknown) {
  if (error instanceof ProjectStateError) {
    const status = error.code === 'project_not_found' ? 404 : 400
    const result: ProjectStateResult = {
      status: status === 404 ? 'not_found' : 'invalid_request',
      source: 'project_state',
      error: { code: error.code, message: error.message },
    }
    return NextResponse.json(result, { status })
  }
  if (error instanceof WorkspaceGuardError) return invalid('workspace_guard', error.message)
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json({ status: 'project_state_error', source: 'project_state', error: { code: 'unexpected_error', message } }, { status: 500 })
}

function invalid(code: string, message: string) {
  return NextResponse.json({ status: 'invalid_request', source: 'project_state', error: { code, message } }, { status: 400 })
}
