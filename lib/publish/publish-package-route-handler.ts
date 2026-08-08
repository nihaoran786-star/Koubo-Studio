import { NextResponse } from 'next/server'
import { PublishPackageArtifactError } from '@/lib/artifacts/publish-package-artifact'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { getCurrentPublishArtifact, PublishArtifactAccessError } from './publish-artifact-access'

export async function handlePublishPackageGet(options: { projectId: string; artifactId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    const artifact = await getCurrentPublishArtifact(workspace, options.artifactId)
    return NextResponse.json({
      status: 'ready',
      source: 'local_publish_package',
      artifact,
      nextStep: 'manual_browser_required',
    })
  } catch (error) {
    if (error instanceof WorkspaceGuardError) return invalid('workspace_guard', error.message, 400)
    if (error instanceof PublishArtifactAccessError) return invalid(error.code, error.message, 404)
    if (error instanceof PublishPackageArtifactError) {
      return invalid('publish_artifact_not_found', '未找到已选择的发布包，请重新准备。', 404)
    }
    return invalid('publish_artifact_error', '发布包读取失败，请重新准备。', 500)
  }
}

function invalid(code: string, message: string, status: number) {
  return NextResponse.json({
    status: status === 404 ? 'invalid_request' : 'publish_error',
    source: 'publish_package_artifact',
    error: { code, message },
  }, { status })
}
