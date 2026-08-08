import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { savePublishPackageArtifact } from '@/lib/artifacts/publish-package-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { handlePublishPackageGet } from './publish-package-route-handler'

const projectId = 'publish-package-recovery-test'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('handlePublishPackageGet', () => {
  it('restores a selected ready package from the project workspace', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const videoPath = path.join(workspace.outputsPath, 'final', 'ready.mp4')
    await fs.mkdir(path.dirname(videoPath), { recursive: true })
    await fs.writeFile(videoPath, 'video')
    await savePublishPackageArtifact({
      workspace,
      artifactId: 'publish-ready',
      sessionId: 'publish-session',
      status: 'ready',
      source: 'local_publish_package',
      postProductionArtifactId: 'post-ready',
      scriptArtifactId: 'script-ready',
      videoPath,
      platforms: [{
        platformId: 'douyin',
        platformName: '抖音',
        browserStatus: 'manual_required',
        publishPageUrl: 'https://creator.douyin.com/creator-micro/content/upload',
        title: '标题',
        description: '正文',
        tags: ['口播'],
      }],
    })
    await writeReadyProject(workspace.rootPath, projectId, 'publish-ready', 'publish-session', 'post-ready', 'script-ready')

    const response = await handlePublishPackageGet({ projectId, artifactId: 'publish-ready' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      artifact: { artifactId: 'publish-ready', projectId },
    })
  })

  it('returns a stable not-found result for a stale selected id', async () => {
    const response = await handlePublishPackageGet({ projectId, artifactId: 'missing' })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      error: { code: 'publish_artifact_not_current' },
    })
  })
})

async function writeReadyProject(rootPath: string, id: string, publishId: string, sessionId: string, editId: string, scriptId: string) {
  const now = '2026-07-16T00:00:00.000Z'
  await fs.writeFile(path.join(rootPath, 'project.json'), JSON.stringify({
    version: 1, revision: 1, projectId: id, title: '测试', status: 'draft', currentStep: 'publish', furthestStep: 'publish',
    stages: {
      script: { status: 'ready', artifactId: scriptId, updatedAt: now },
      voice: { status: 'ready', artifactId: 'audio-ready', source: 'indextts2', updatedAt: now },
      digitalHuman: { status: 'ready', artifactId: 'render-ready', source: 'heygem', updatedAt: now },
      edit: { status: 'ready', artifactId: editId, source: 'local_ffmpeg', updatedAt: now },
      publish: { status: 'ready', artifactId: publishId, source: 'local_publish_package', operation: { id: 'publish-op', sessionId, upstreamArtifactId: editId, startedAt: now }, updatedAt: now },
    },
    script: { topic: '测试', platforms: [], duration: '30 秒', tone: '自然', chatStage: 'generated', messages: [], title: '测试', hook: '', body: '', caption: '', tags: [], generated: true, updatedAt: now },
    createdAt: now, updatedAt: now,
  }), 'utf8')
}
