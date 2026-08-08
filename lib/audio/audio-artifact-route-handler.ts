import { NextResponse } from 'next/server'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'
import { getLatestReadyAudioArtifact, type LatestAudioArtifactResult } from './audio-artifact-query'

export async function handleLatestAudioArtifactGet(
  request: Request,
  options: {
    projectId: string
    getLatest?: (input: { projectId: string; scriptArtifactId?: string }) => Promise<LatestAudioArtifactResult>
  },
) {
  try {
    const scriptArtifactId = new URL(request.url).searchParams.get('scriptArtifactId')?.trim() || undefined
    const result = await (options.getLatest ?? getLatestFromWorkspace)({
      projectId: options.projectId,
      scriptArtifactId,
    })
    return NextResponse.json(result, { status: result.status === 'ok' ? 200 : 404 })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleAudioArtifactFileGet(
  request: Request,
  options: {
    projectId: string
    artifactId: string
    openFile?: (input: { projectId: string; artifactId: string }) => Promise<Response>
  },
) {
  try {
    return await (options.openFile ?? openArtifactFileFromWorkspace)({
      projectId: options.projectId,
      artifactId: options.artifactId,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

async function getLatestFromWorkspace(input: { projectId: string; scriptArtifactId?: string }) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  return getLatestReadyAudioArtifact(workspace, { scriptArtifactId: input.scriptArtifactId })
}

async function openArtifactFileFromWorkspace(input: { projectId: string; artifactId: string }) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  const artifact = await getAudioArtifact(workspace, input.artifactId)
  return createWorkspaceMediaResponse({
    rootPath: workspace.rootPath,
    filePath: artifact.outputPath,
    contentType: artifact.parameters.outputFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
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
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json(
      {
        status: 'audio_artifact_error',
        source: 'audio_artifact_file',
        error: { code: error.code, message: error.message },
      },
      { status: error.code === 'invalid_range' ? 416 : 404 },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json(
    {
      status: 'audio_artifact_error',
      source: 'audio_artifact_query',
      error: {
        code: 'unexpected_error',
        message,
      },
    },
    { status: 500 },
  )
}
