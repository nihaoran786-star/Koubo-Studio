import { listAudioArtifacts, type AudioArtifact } from '@/lib/artifacts/audio-artifact'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'

export interface SelectedAudioArtifactState {
  artifactId: string
  outputPath: string
  durationSeconds: number
  playbackUrl: string
  createdAt: string
}

export type LatestAudioArtifactResult =
  | {
      status: 'ok'
      source: 'audio_artifact_query'
      selected: SelectedAudioArtifactState
    }
  | {
      status: 'not_found'
      source: 'audio_artifact_query'
      selected?: never
    }
  | {
      status: 'error'
      source: string
      selected?: never
      error: {
        code: string
        message: string
      }
    }

export async function getLatestReadyAudioArtifact(
  workspace: ProjectWorkspace,
  options: {
    scriptArtifactId?: string
  } = {},
): Promise<LatestAudioArtifactResult> {
  const artifacts = await listAudioArtifacts(workspace)
  const latest = artifacts
    .filter((artifact) => (
      artifact.status === 'ready' &&
      (!options.scriptArtifactId || artifact.parameters.scriptArtifactId === options.scriptArtifactId)
    ))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

  if (!latest) {
    return {
      status: 'not_found',
      source: 'audio_artifact_query',
      selected: undefined,
    }
  }

  return {
    status: 'ok',
    source: 'audio_artifact_query',
    selected: toSelectedAudioArtifact(workspace.projectId, latest),
  }
}

function toSelectedAudioArtifact(projectId: string, artifact: AudioArtifact): SelectedAudioArtifactState {
  return {
    artifactId: artifact.artifactId,
    outputPath: artifact.outputPath,
    durationSeconds: artifact.durationSeconds,
    playbackUrl: `/api/projects/${encodeURIComponent(projectId)}/audio-artifacts/${encodeURIComponent(artifact.artifactId)}/file`,
    createdAt: artifact.createdAt,
  }
}
