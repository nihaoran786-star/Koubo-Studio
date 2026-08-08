import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { savePostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { getPublishPackageArtifact } from '@/lib/artifacts/publish-package-artifact'
import { saveRenderArtifact } from '@/lib/artifacts/render-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { runPublishAgent } from './publish-agent-service'
import { createDefaultEditPlan } from '@/lib/post-production/edit-plan'
import { createProjectState, getProjectState, mutateProjectState } from '@/lib/project-state/project-state-service'

const projectId = 'test-local-publish-agent'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

async function seedReadyChain(options: { writeVideo?: boolean; approvalStatus?: 'draft' | 'approved' } = {}) {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const videoPath = path.join(workspace.artifactsPath, 'post-production', 'post-001.mp4')
  const coverPath = path.join(workspace.artifactsPath, 'post-production', 'post-001.png')
  await saveScriptArtifact({
    workspace,
    artifactId: 'script-001',
    sessionId: 'script-session-001',
    approvalStatus: options.approvalStatus ?? 'approved',
    content: {
      title: '测试标题', hook: '开头', body: '测试正文', caption: '发布正文', tags: ['#口播'],
      durationSeconds: 8, voiceNotes: '', shotNotes: '', riskNotes: '',
    },
  })
  await saveAudioArtifact({
    workspace,
    artifactId: 'audio-001',
    sessionId: 'voice-session-001',
    status: 'ready',
    source: 'indextts2',
    outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'),
    durationSeconds: 8,
    parameters: { scriptArtifactId: 'script-001', text: '测试正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
  })
  await saveRenderArtifact({
    workspace,
    artifactId: 'render-001',
    sessionId: 'render-session-001',
    status: 'ready',
    source: 'heygem',
    scriptArtifactId: 'script-001',
    audioArtifactId: 'audio-001',
    outputPath: path.join(workspace.artifactsPath, 'render', 'render-001.mp4'),
    durationSeconds: 8,
    avatar: { source: 'library', id: 'avatar-001', name: '测试形象' },
    mode: 'standard',
  })
  await savePostProductionArtifact({
    workspace,
    artifactId: 'post-001',
    sessionId: 'post-session-001',
    status: 'ready',
    source: 'local_ffmpeg',
    renderArtifactId: 'render-001',
    scriptArtifactId: 'script-001',
    outputPath: videoPath,
    coverPath,
    durationSeconds: 8,
    parameters: { plan: createDefaultEditPlan(), request: '导出成片' },
    skillCall: { skillId: 'builtin:post-production', skillName: 'post-production' },
  })
  if (options.writeVideo !== false) {
    await fs.mkdir(path.dirname(videoPath), { recursive: true })
    await fs.writeFile(videoPath, 'video')
    await fs.writeFile(coverPath, 'cover')
  }
  await createProjectState({
    projectId,
    script: {
      artifactId: 'script-001',
      approvalStatus: options.approvalStatus ?? 'approved',
      topic: '测试主题', platforms: ['抖音'], duration: '8 秒', tone: '自然', chatStage: 'generated', messages: [],
      title: '测试标题', hook: '开头', body: '测试正文', caption: '发布正文', tags: ['#口播'], generated: true,
      updatedAt: '2026-07-15T00:00:00.000Z',
    },
  })
  await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-001' })
  await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'digitalHuman', artifactId: 'render-001' })
  await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'edit', artifactId: 'post-001' })
  return workspace
}

describe('runPublishAgent', () => {
  it('creates a truthful local package and leaves browser work manual', async () => {
    const workspace = await seedReadyChain()
    const result = await runPublishAgent({
      projectId,
      sessionId: 'publish-session-001',
      input: { platforms: ['douyin', 'xiaohongshu'] },
      now: '2026-07-15T00:00:00.000Z',
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected ready')
    expect(result).toMatchObject({ source: 'local_publish_package', nextStep: 'manual_browser_required' })
    expect(result.artifact.platforms).toEqual([
      expect.objectContaining({ platformId: 'douyin', browserStatus: 'manual_required' }),
      expect.objectContaining({ platformId: 'xiaohongshu', browserStatus: 'manual_required' }),
    ])
    await expect(getPublishPackageArtifact(workspace, result.artifact.artifactId)).resolves.toEqual(result.artifact)
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { publish: { status: 'ready', artifactId: result.artifact.artifactId, source: 'local_publish_package' } },
    })
  })

  it('rejects unsupported platforms', async () => {
    await seedReadyChain()
    await expect(runPublishAgent({
      projectId,
      sessionId: 'publish-session-001',
      input: { platforms: ['youtube'] },
    })).resolves.toMatchObject({ status: 'invalid_request', error: { code: 'invalid_platforms' } })
  })

  it('rejects missing local video instead of claiming success', async () => {
    await seedReadyChain({ writeVideo: false })
    await expect(runPublishAgent({
      projectId,
      sessionId: 'publish-session-001',
      input: { platforms: ['douyin'] },
    })).resolves.toMatchObject({ status: 'invalid_request', error: { code: 'publish_video_missing' } })
    await expect(getProjectState(projectId)).resolves.toMatchObject({
      stages: { publish: { status: 'failed', error: { code: 'publish_video_missing' } } },
    })
  })
})
