import { getPublishPackageArtifact, type PublishPackageArtifact } from '@/lib/artifacts/publish-package-artifact'
import { getProjectState } from '@/lib/project-state/project-state-service'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'

export class PublishArtifactAccessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'PublishArtifactAccessError'
  }
}

/**
 * Resolves a publish package only when project.json currently commits that
 * exact artifact and its edit/script/task lineage still matches.
 */
export async function getCurrentPublishArtifact(
  workspace: ProjectWorkspace,
  requestedArtifactId: string,
): Promise<PublishPackageArtifact> {
  const artifactId = assertSafeSegment(requestedArtifactId, 'artifactId')
  const project = await getProjectState(workspace.projectId).catch(() => undefined)
  const publish = project?.stages.publish
  if (
    !project ||
    publish?.status !== 'ready' ||
    publish.source !== 'local_publish_package' ||
    publish.artifactId !== artifactId ||
    !publish.operation
  ) {
    throw new PublishArtifactAccessError('publish_artifact_not_current', '该发布包不是当前项目已确认的发布包，请重新准备。')
  }

  const artifact = await getPublishPackageArtifact(workspace, artifactId).catch(() => undefined)
  if (!artifact || artifact.status !== 'ready') {
    throw new PublishArtifactAccessError('publish_artifact_not_ready', '当前发布包不存在或尚未准备完成。')
  }
  if (
    artifact.sessionId !== publish.operation.sessionId ||
    artifact.postProductionArtifactId !== publish.operation.upstreamArtifactId ||
    artifact.postProductionArtifactId !== project.stages.edit.artifactId ||
    artifact.scriptArtifactId !== project.stages.script.artifactId
  ) {
    throw new PublishArtifactAccessError('publish_artifact_lineage_mismatch', '发布包与当前成片或文案不一致，请重新准备。')
  }
  return artifact
}
