import { NextResponse } from 'next/server'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'
import { getCurrentRenderArtifactAccess, RenderArtifactAccessError } from './render-artifact-access'

export async function handleRenderArtifactFileGet(
  request: Request,
  options: {
    projectId: string
    artifactId: string
    openFile?: (input: { projectId: string; artifactId: string; request: Request }) => Promise<Response>
  },
) {
  try {
    return await (options.openFile ?? openRenderFileFromWorkspace)({
      projectId: options.projectId,
      artifactId: options.artifactId,
      request,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

async function openRenderFileFromWorkspace(input: { projectId: string; artifactId: string; request: Request }) {
  const access = await getCurrentRenderArtifactAccess(input)
  return createWorkspaceMediaResponse({
    rootPath: access.renderRootPath,
    filePath: access.artifact.outputPath,
    contentType: 'video/mp4',
    rangeEnabled: true,
    acceptRanges: true,
    rangeHeader: input.request.headers.get('range') ?? undefined,
  })
}

function errorResponse(error: unknown) {
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
  if (error instanceof RenderArtifactAccessError) {
    return NextResponse.json(
      {
        status: 'render_artifact_error',
        source: 'render_artifact_file',
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: 404 },
    )
  }
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json(
      {
        status: 'render_artifact_error',
        source: 'render_artifact_file',
        error: { code: error.code, message: error.message },
      },
      { status: error.code === 'invalid_range' ? 416 : 404 },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json(
    {
      status: 'render_artifact_error',
      source: 'render_artifact_file',
      error: {
        code: 'unexpected_error',
        message,
      },
    },
    { status: 500 },
  )
}
