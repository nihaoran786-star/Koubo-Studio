import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { savePublishPackageArtifact, type PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { BrowserPublishService } from './service'
import type {
  BrowserPage,
  BrowserPublishAdapter,
  BrowserPublishDraft,
  BrowserRuntime,
  BrowserSession,
} from './types'

const projectIds = ['browser-publish-test', 'browser-publish-escape']

afterEach(async () => {
  await Promise.all(projectIds.map((projectId) => fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })))
  await fs.rm(path.join(getWorkspacesRoot(), '.browser-test'), { recursive: true, force: true })
})

describe('BrowserPublishService', () => {
  it('打开可见持久化浏览器，登录后填写草稿并停在用户提交前', async () => {
    const artifactId = await createPublishPackage('browser-publish-test')
    const page = createPage()
    const session: BrowserSession = { page, close: vi.fn(async () => undefined) }
    const runtime: BrowserRuntime = { openPersistentContext: vi.fn(async () => session) }
    let readiness: 'login_required' | 'ready_to_fill' = 'login_required'
    const fillDraft = vi.fn(async (_page: BrowserPage, _draft: BrowserPublishDraft) => undefined)
    const adapter = createAdapter('douyin', () => readiness, fillDraft)
    const service = new BrowserPublishService({
      runtime,
      adapters: { douyin: adapter, xiaohongshu: createAdapter('xiaohongshu', () => 'login_required') },
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'C:\\Browser\\browser.exe',
      now: () => '2026-07-16T00:00:00.000Z',
    })

    const target = { projectId: 'browser-publish-test', artifactId, platformId: 'douyin' as const }
    await expect(service.open(target)).resolves.toMatchObject({ status: 'login_required', source: 'visible_browser' })
    expect(service.getSnapshot().pageUrl).toBe('https://douyin.test/upload')
    expect(runtime.openPersistentContext).toHaveBeenCalledWith({
      executablePath: 'C:\\Browser\\browser.exe',
      profilePath: path.join(getWorkspacesRoot(), '.browser-test', 'douyin'),
    })

    readiness = 'ready_to_fill'
    await expect(service.refresh()).resolves.toMatchObject({ status: 'ready_to_fill' })
    await expect(service.fill(target)).resolves.toMatchObject({ status: 'awaiting_user_submit' })
    expect(fillDraft).toHaveBeenCalledOnce()
    expect(fillDraft.mock.calls[0]?.[1]).toMatchObject({
      platformId: 'douyin',
      title: '发布标题',
      description: '发布正文',
      tags: ['口播'],
    })

    await expect(service.close()).resolves.toMatchObject({ status: 'closed' })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('二次校验视频必须存在且不能越过 workspace', async () => {
    const workspace = await ensureProjectWorkspace('browser-publish-escape', 'digital-human')
    const outsidePath = path.resolve(workspace.rootPath, '..', 'outside.mp4')
    await fs.writeFile(outsidePath, 'video')
    const { artifact } = await savePublishPackageArtifact({
      workspace,
      artifactId: 'publish-escape',
      sessionId: 'session-escape',
      status: 'ready',
      source: 'local_publish_package',
      postProductionArtifactId: 'post-escape',
      scriptArtifactId: 'script-escape',
      videoPath: outsidePath,
      platforms: [platformPackage('douyin')],
    })
    await writeReadyProject(workspace.rootPath, workspace.projectId, artifact.artifactId, artifact.sessionId, artifact.postProductionArtifactId, artifact.scriptArtifactId)
    const runtime: BrowserRuntime = { openPersistentContext: vi.fn() }
    const service = new BrowserPublishService({
      runtime,
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'unused',
    })

    await expect(service.open({
      projectId: workspace.projectId,
      artifactId: artifact.artifactId,
      platformId: 'douyin',
    })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'publish_video_path_escape' },
    })
    expect(runtime.openPersistentContext).not.toHaveBeenCalled()
    await fs.rm(outsidePath, { force: true })
  })

  it('串行处理并且任意时刻只保留一个 persistent context', async () => {
    const artifactId = await createPublishPackage('browser-publish-test')
    let active = 0
    let peak = 0
    const sessions: BrowserSession[] = []
    const runtime: BrowserRuntime = {
      openPersistentContext: vi.fn(async () => {
        active += 1
        peak = Math.max(peak, active)
        const session: BrowserSession = {
          page: createPage(),
          close: vi.fn(async () => { active -= 1 }),
        }
        sessions.push(session)
        return session
      }),
    }
    const service = new BrowserPublishService({
      runtime,
      adapters: {
        douyin: createAdapter('douyin', () => 'ready_to_fill'),
        xiaohongshu: createAdapter('xiaohongshu', () => 'ready_to_fill'),
      },
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'browser.exe',
    })

    await Promise.all([
      service.open({ projectId: 'browser-publish-test', artifactId, platformId: 'douyin' }),
      service.open({ projectId: 'browser-publish-test', artifactId, platformId: 'xiaohongshu' }),
    ])
    expect(peak).toBe(1)
    expect(sessions[0]?.close).toHaveBeenCalledOnce()
    expect(service.getSnapshot()).toMatchObject({ status: 'ready_to_fill', platformId: 'xiaohongshu' })
    await service.close()
  })

  it('浏览器被用户直接关闭时不会保留伪活跃状态', async () => {
    const artifactId = await createPublishPackage('browser-publish-test')
    let closedListener: (() => void) | undefined
    const session: BrowserSession = {
      page: createPage(),
      close: async () => undefined,
      onClosed(listener) {
        closedListener = listener
        return () => { closedListener = undefined }
      },
    }
    const service = new BrowserPublishService({
      runtime: { openPersistentContext: async () => session },
      adapters: {
        douyin: createAdapter('douyin', () => 'ready_to_fill'),
        xiaohongshu: createAdapter('xiaohongshu', () => 'ready_to_fill'),
      },
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'browser.exe',
    })
    await service.open({ projectId: 'browser-publish-test', artifactId, platformId: 'douyin' })
    closedListener?.()
    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      error: { code: 'browser_closed_unexpectedly' },
    })
    await expect(service.fill()).resolves.toMatchObject({ status: 'failed', error: { code: 'browser_not_open' } })
  })

  it('待用户提交时拒绝静默切换平台并保留当前会话', async () => {
    const artifactId = await createPublishPackage('browser-publish-test')
    const close = vi.fn(async () => undefined)
    const service = new BrowserPublishService({
      runtime: { openPersistentContext: async () => ({ page: createPage(), close }) },
      adapters: {
        douyin: createAdapter('douyin', () => 'ready_to_fill'),
        xiaohongshu: createAdapter('xiaohongshu', () => 'ready_to_fill'),
      },
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'browser.exe',
    })
    const douyin = { projectId: 'browser-publish-test', artifactId, platformId: 'douyin' as const }
    await service.open(douyin)
    await service.fill(douyin)

    await expect(service.open({ ...douyin, platformId: 'xiaohongshu' })).resolves.toMatchObject({
      status: 'awaiting_user_submit',
      platformId: 'douyin',
      error: { code: 'browser_active_draft' },
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('登录期间项目成片变化后拒绝填写旧发布包', async () => {
    const artifactId = await createPublishPackage('browser-publish-test')
    const fillDraft = vi.fn(async () => undefined)
    const service = new BrowserPublishService({
      runtime: { openPersistentContext: async () => ({ page: createPage(), close: async () => undefined }) },
      adapters: {
        douyin: createAdapter('douyin', () => 'ready_to_fill', fillDraft),
        xiaohongshu: createAdapter('xiaohongshu', () => 'ready_to_fill'),
      },
      profileRoot: path.join(getWorkspacesRoot(), '.browser-test'),
      resolveExecutable: async () => 'browser.exe',
    })
    const target = { projectId: 'browser-publish-test', artifactId, platformId: 'douyin' as const }
    await service.open(target)

    const projectPath = path.join(getWorkspacesRoot(), 'browser-publish-test', 'project.json')
    const project = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    project.stages.publish = { status: 'needs_input', updatedAt: '2026-07-16T00:01:00.000Z' }
    await fs.writeFile(projectPath, JSON.stringify(project), 'utf8')

    await expect(service.fill(target)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'publish_artifact_not_current' },
    })
    expect(fillDraft).not.toHaveBeenCalled()
  })
})

async function createPublishPackage(projectId: string) {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const videoPath = path.join(workspace.outputsPath, 'final', 'publish.mp4')
  await fs.mkdir(path.dirname(videoPath), { recursive: true })
  await fs.writeFile(videoPath, 'video')
  const { artifact } = await savePublishPackageArtifact({
    workspace,
    artifactId: 'publish-ready',
    sessionId: 'publish-session',
    status: 'ready',
    source: 'local_publish_package',
    postProductionArtifactId: 'post-ready',
    scriptArtifactId: 'script-ready',
    videoPath,
    platforms: [platformPackage('douyin'), platformPackage('xiaohongshu')],
  })
  await writeReadyProject(workspace.rootPath, projectId, artifact.artifactId, artifact.sessionId, artifact.postProductionArtifactId, artifact.scriptArtifactId)
  return artifact.artifactId
}

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

function platformPackage(platformId: PublishPlatformId) {
  return {
    platformId,
    platformName: platformId === 'douyin' ? '抖音' : '小红书',
    browserStatus: 'manual_required' as const,
    publishPageUrl: platformId === 'douyin' ? 'https://douyin.test/upload' : 'https://xiaohongshu.test/upload',
    title: '发布标题',
    description: '发布正文',
    tags: ['口播'],
  }
}

function createAdapter(
  platformId: PublishPlatformId,
  inspect: () => 'login_required' | 'ready_to_fill',
  fillDraft: BrowserPublishAdapter['fillDraft'] = async () => undefined,
): BrowserPublishAdapter {
  return {
    platformId,
    publishPageUrl: `https://${platformId}.test/upload`,
    open: async () => undefined,
    inspect: async () => inspect(),
    fillDraft,
  }
}

function createPage(): BrowserPage {
  return {
    goto: async () => undefined,
    url: () => 'https://creator.test/upload',
    locator: () => ({
      count: async () => 0,
      first() { return this },
      isVisible: async () => false,
      fill: async () => undefined,
      setInputFiles: async () => undefined,
    }),
  }
}
