import fs from 'node:fs/promises'
import path from 'node:path'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { getPostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { savePublishPackageArtifact, isPublishPlatformId, type PublishPackageArtifact, type PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import { getRenderArtifact } from '@/lib/artifacts/render-artifact'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { appendAgentSessionMetadata } from '@/lib/agents/agent-session-index'
import { createAgentSessionMetadata } from '@/lib/agents/agent-session'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { prepareBrowserPublishTargets } from './browser-publish-adapter'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  failProjectStageOperation,
  getProjectState,
  markProjectStageOperationRunning,
  ProjectStateError,
} from '@/lib/project-state/project-state-service'

export interface PublishAgentInput {
  platforms: PublishPlatformId[]
  title?: string
  description?: string
  tags?: string[]
}

export type RunPublishAgentResult =
  | {
      status: 'ready'
      source: 'local_publish_package'
      artifact: PublishPackageArtifact
      nextStep: 'manual_browser_required'
    }
  | {
      status: 'invalid_request' | 'publish_error'
      source: 'publish_agent'
      error: { code: string; message: string }
    }

export async function runPublishAgent(input: {
  projectId: string
  sessionId: string
  input: PublishAgentInput | unknown
  now?: string
}): Promise<RunPublishAgentResult> {
  let activeOperation: { projectId: string; operationId: string } | undefined
  try {
    const projectId = assertSafeSegment(input.projectId, 'projectId')
    const sessionId = assertSafeSegment(input.sessionId, 'sessionId')
    const agentInput = normalizePublishAgentInput(input.input)
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const project = await getProjectState(projectId)
    const editStage = project.stages.edit
    const scriptStage = project.stages.script
    if (editStage.status !== 'ready' || !editStage.artifactId) {
      return invalidRequest('edit_not_ready', '请先完成当前项目的本地剪辑并导出成片。')
    }
    if (scriptStage.status !== 'ready' || !scriptStage.artifactId) {
      return invalidRequest('script_not_ready', '当前项目文案尚未确认。')
    }

    const operationId = `publish-op-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
    await beginProjectStageOperation({
      projectId,
      stage: 'publish',
      operationId,
      sessionId,
      source: 'local_publish_package',
      expectedUpstreamArtifactId: editStage.artifactId,
      now: input.now,
    })
    activeOperation = { projectId, operationId }
    await markProjectStageOperationRunning({ projectId, stage: 'publish', operationId, now: input.now })

    const postArtifact = await getPostProductionArtifact(workspace, editStage.artifactId).catch(() => undefined)
    if (!postArtifact || postArtifact.status !== 'ready') {
      throw new PublishAgentInputValidationError('missing_post_production_artifact', '当前项目成片不存在或尚未就绪。')
    }
    if (!postArtifact.scriptArtifactId) {
      throw new PublishAgentInputValidationError('missing_script_artifact', '后期成片缺少文案关联，不能生成发布包。')
    }
    if (postArtifact.artifactId !== editStage.artifactId || postArtifact.scriptArtifactId !== scriptStage.artifactId) {
      throw new PublishAgentInputValidationError('edit_lineage_mismatch', '当前成片与项目文案不一致，请重新剪辑。')
    }
    const renderArtifact = await getRenderArtifact(workspace, postArtifact.renderArtifactId).catch(() => undefined)
    if (!renderArtifact || renderArtifact.status !== 'ready') {
      throw new PublishAgentInputValidationError('missing_render_artifact', '未找到后期成片对应的数字人视频。')
    }
    if (renderArtifact.scriptArtifactId !== postArtifact.scriptArtifactId) {
      throw new PublishAgentInputValidationError('render_script_mismatch', '数字人视频与后期成片的文案关联不一致。')
    }
    const scriptArtifact = await getScriptArtifact(workspace, postArtifact.scriptArtifactId).catch(() => undefined)
    if (!scriptArtifact || scriptArtifact.approvalStatus !== 'approved') {
      throw new PublishAgentInputValidationError('script_not_approved', '文案尚未确认，不能生成发布包。')
    }
    const audioArtifact = await getAudioArtifact(workspace, renderArtifact.audioArtifactId).catch(() => undefined)
    if (!audioArtifact || audioArtifact.status !== 'ready') {
      throw new PublishAgentInputValidationError('audio_artifact_not_ready', '数字人视频关联的声音尚未就绪。')
    }
    if (audioArtifact.parameters.scriptArtifactId !== scriptArtifact.artifactId) {
      throw new PublishAgentInputValidationError('audio_script_mismatch', '声音与发布文案不一致，请重新生成后续产物。')
    }

    const assetError = await validatePublishAssets({
      workspacePath: workspace.rootPath,
      videoPath: postArtifact.outputPath,
      coverPath: postArtifact.coverPath,
    })
    if (assetError?.status === 'invalid_request') {
      throw new PublishAgentInputValidationError(assetError.error.code, assetError.error.message)
    }

    const title = agentInput.title ?? scriptArtifact.content.title ?? '未命名口播作品'
    const description = agentInput.description ?? scriptArtifact.content.caption ?? scriptArtifact.content.body
    const tags = agentInput.tags?.length ? agentInput.tags : scriptArtifact.content.tags
    const platforms = prepareBrowserPublishTargets({
      platforms: agentInput.platforms,
      title,
      description,
      tags,
    })
    const artifactId = `publish-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
    const { artifact } = await savePublishPackageArtifact({
      workspace,
      artifactId,
      sessionId,
      status: 'ready',
      source: 'local_publish_package',
      postProductionArtifactId: postArtifact.artifactId,
      scriptArtifactId: scriptArtifact.artifactId,
      videoPath: path.normalize(postArtifact.outputPath),
      coverPath: postArtifact.coverPath ? path.normalize(postArtifact.coverPath) : undefined,
      platforms,
      now: input.now,
    })
    await appendAgentSessionMetadata(
      workspace,
      createAgentSessionMetadata({
        sessionId,
        sessionKind: 'subagent',
        parentSessionId: postArtifact.sessionId,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.rootPath,
        agentRole: 'publish',
        artifactId: artifact.artifactId,
      }),
    )
    await completeProjectStageOperation({
      projectId,
      stage: 'publish',
      operationId,
      artifactId: artifact.artifactId,
      now: input.now,
    })
    activeOperation = undefined
    return {
      status: 'ready',
      source: 'local_publish_package',
      artifact,
      nextStep: 'manual_browser_required',
    }
  } catch (error) {
    const normalizedError = normalizePublishFailure(error)
    if (activeOperation) {
      await failProjectStageOperation({
        projectId: activeOperation.projectId,
        stage: 'publish',
        operationId: activeOperation.operationId,
        error: normalizedError,
        now: input.now,
      }).catch(() => undefined)
    }
    if (error instanceof PublishAgentInputValidationError || error instanceof WorkspaceGuardError || error instanceof ProjectStateError) {
      return invalidRequest(
        error instanceof PublishAgentInputValidationError ? error.code : error instanceof ProjectStateError ? error.code : 'workspace_guard',
        error.message,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'publish_error',
      source: 'publish_agent',
      error: { code: 'publish_package_failed', message },
    }
  }
}

class PublishAgentInputValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'PublishAgentInputValidationError'
  }
}

function normalizePublishAgentInput(value: unknown): PublishAgentInput {
  if (!isRecord(value)) throw new PublishAgentInputValidationError('invalid_input', '发布参数格式无效。')
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    throw new PublishAgentInputValidationError('invalid_platforms', '至少选择一个发布平台。')
  }
  const platforms = [...new Set(value.platforms)]
  if (!platforms.every(isPublishPlatformId)) {
    throw new PublishAgentInputValidationError('invalid_platforms', '仅支持抖音和小红书。')
  }
  return {
    platforms,
    title: readOptionalString(value.title),
    description: readOptionalString(value.description),
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim())).map((tag) => tag.trim())
      : undefined,
  }
}

function normalizePublishFailure(error: unknown) {
  if (error instanceof PublishAgentInputValidationError || error instanceof ProjectStateError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof WorkspaceGuardError) return { code: 'workspace_guard', message: error.message }
  return { code: 'publish_package_failed', message: error instanceof Error ? error.message : '发布包准备失败。' }
}

async function validatePublishAssets(input: {
  workspacePath: string
  videoPath: string
  coverPath?: string
}): Promise<RunPublishAgentResult | undefined> {
  const root = path.join(input.workspacePath, 'artifacts', 'post-production')
  const videoError = await validateAsset(root, input.videoPath, 'publish_video')
  if (videoError) return videoError
  return input.coverPath ? validateAsset(root, input.coverPath, 'publish_cover') : undefined
}

async function validateAsset(root: string, filePath: string, codePrefix: string) {
  try {
    const safePath = assertInsideRoot(root, filePath)
    const stat = await fs.stat(safePath)
    if (!stat.isFile() || stat.size <= 0) {
      return invalidRequest(`${codePrefix}_missing`, `${codePrefix === 'publish_video' ? '后期成片' : '封面'}不存在或为空。`)
    }
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      return invalidRequest(`${codePrefix}_path_escape`, '发布素材路径越过了当前 workspace。')
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      return invalidRequest(`${codePrefix}_missing`, `${codePrefix === 'publish_video' ? '后期成片' : '封面'}不存在或为空。`)
    }
    throw error
  }
}

function invalidRequest(code: string, message: string): RunPublishAgentResult {
  return { status: 'invalid_request', source: 'publish_agent', error: { code, message } }
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
