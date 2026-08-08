import { NextResponse } from 'next/server'
import { getPostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'

export async function handlePostProductionArtifactFileGet(
  request: Request,
  options: {
    projectId: string
    artifactId: string
    openFile?: (input: { projectId: string; artifactId: string; kind: 'video' | 'cover'; rangeHeader?: string }) => Promise<Response>
  },
) {
  try {
    const url = new URL(request.url)
    const kind = url.searchParams.get('kind') === 'cover' ? 'cover' : 'video'
    return await (options.openFile ?? openPostProductionFileFromWorkspace)({
      projectId: options.projectId,
      artifactId: options.artifactId,
      kind,
      rangeHeader: request.headers.get('range') ?? undefined,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

async function openPostProductionFileFromWorkspace(input: { projectId: string; artifactId: string; kind: 'video' | 'cover'; rangeHeader?: string }) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  const artifact = await getPostProductionArtifact(workspace, input.artifactId)
  const targetPath = input.kind === 'cover' ? artifact.coverPath : artifact.outputPath
  if (!targetPath) {
    throw new PostProductionArtifactFileError('missing_file', 'post-production artifact 缺少请求的文件。')
  }
  const safePath = assertInsideRoot(workspace.rootPath, targetPath)
  return createWorkspaceMediaResponse({
    rootPath: workspace.rootPath,
    filePath: safePath,
    contentType: input.kind === 'cover' ? contentTypeForCover(safePath) : 'video/mp4',
    rangeEnabled: input.kind === 'video',
    rangeHeader: input.rangeHeader,
    acceptRanges: true,
  })
}

function contentTypeForCover(filePath: string) {
  const normalized = filePath.toLowerCase()
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg'
  if (normalized.endsWith('.webp')) return 'image/webp'
  return 'image/png'
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
  if (error instanceof PostProductionArtifactFileError) {
    return NextResponse.json(
      {
        status: 'post_production_artifact_error',
        source: 'post_production_artifact_file',
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: error.code === 'invalid_range' ? 416 : 404 },
    )
  }
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json(
      {
        status: 'post_production_artifact_error',
        source: 'post_production_artifact_file',
        error: { code: error.code, message: error.message },
      },
      { status: error.code === 'invalid_range' ? 416 : 404 },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json(
    {
      status: 'post_production_artifact_error',
      source: 'post_production_artifact_file',
      error: {
        code: 'unexpected_error',
        message,
      },
    },
    { status: 500 },
  )
}

class PostProductionArtifactFileError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PostProductionArtifactFileError'
  }
}
