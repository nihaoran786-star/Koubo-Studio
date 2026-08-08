import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { getRenderArtifact, RenderArtifactError, type RenderArtifact } from '@/lib/artifacts/render-artifact'
import { getProjectState } from '@/lib/project-state/project-state-service'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'

export class RenderArtifactAccessError extends Error {
  constructor(
    public readonly code: 'artifact_not_current',
    message: string,
  ) {
    super(message)
    this.name = 'RenderArtifactAccessError'
  }
}

export type CurrentRenderArtifactAccess = {
  artifact: RenderArtifact
  workspace: ProjectWorkspace
  renderRootPath: string
}

/**
 * Authorises access to the one render artifact currently committed in
 * project.json. File routes must not infer currency from an artifact JSON.
 */
export async function getCurrentRenderArtifactAccess(input: {
  projectId: string
  artifactId: string
}): Promise<CurrentRenderArtifactAccess> {
  const projectId = assertSafeSegment(input.projectId, 'projectId')
  const artifactId = assertSafeSegment(input.artifactId, 'artifactId')
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const [project, artifact] = await Promise.all([
    getProjectState(projectId),
    getRenderArtifact(workspace, artifactId).catch((error) => {
      if (error instanceof RenderArtifactError) {
        throw new RenderArtifactAccessError('artifact_not_current', '该数字人视频不存在或已被替代。')
      }
      throw error
    }),
  ])
  const stage = project.stages.digitalHuman
  const operation = stage.operation
  const isCurrent =
    artifact.status === 'ready' &&
    artifact.source === 'heygem' &&
    stage.status === 'ready' &&
    stage.source === 'heygem' &&
    stage.artifactId === artifact.artifactId &&
    operation?.id === artifact.artifactId &&
    operation.sessionId === artifact.sessionId &&
    operation.upstreamArtifactId === artifact.audioArtifactId &&
    project.stages.voice.status === 'ready' &&
    project.stages.voice.artifactId === artifact.audioArtifactId &&
    project.stages.script.status === 'ready' &&
    project.stages.script.artifactId === artifact.scriptArtifactId

  if (!isCurrent) {
    throw new RenderArtifactAccessError('artifact_not_current', '该数字人视频已被更新的创作结果替代。')
  }

  return {
    artifact,
    workspace,
    renderRootPath: resolveArtifactPath(workspace, 'render', '.'),
  }
}
