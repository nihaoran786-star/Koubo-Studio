import fs from 'node:fs/promises'
import path from 'node:path'
import { isPublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { BrowserAdapterError } from './adapter-helpers'
import { douyinBrowserPublishAdapter } from './adapters/douyin'
import { xiaohongshuBrowserPublishAdapter } from './adapters/xiaohongshu'
import { BrowserRuntimeError, PlaywrightBrowserRuntime, resolveBrowserExecutable } from './runtime'
import type {
  BrowserPublishAdapter,
  BrowserPublishDraft,
  BrowserPublishSnapshot,
  BrowserPublishTarget,
  BrowserRuntime,
  BrowserSession,
} from './types'
import { getCurrentPublishArtifact, PublishArtifactAccessError } from '../publish-artifact-access'

const DEFAULT_ADAPTERS: Record<BrowserPublishTarget['platformId'], BrowserPublishAdapter> = {
  douyin: douyinBrowserPublishAdapter,
  xiaohongshu: xiaohongshuBrowserPublishAdapter,
}

export interface BrowserPublishServiceDependencies {
  runtime?: BrowserRuntime
  adapters?: Record<BrowserPublishTarget['platformId'], BrowserPublishAdapter>
  profileRoot?: string
  resolveExecutable?: () => Promise<string>
  now?: () => string
}

export class BrowserPublishService {
  private readonly runtime: BrowserRuntime
  private readonly adapters: Record<BrowserPublishTarget['platformId'], BrowserPublishAdapter>
  private readonly profileRoot?: string
  private readonly resolveExecutable: () => Promise<string>
  private readonly now: () => string
  private snapshot: BrowserPublishSnapshot
  private session?: BrowserSession
  private unsubscribeSessionClosed?: () => void
  private active?: BrowserPublishTarget & { draft: BrowserPublishDraft }
  private operation: Promise<unknown> = Promise.resolve()

  constructor(dependencies: BrowserPublishServiceDependencies = {}) {
    this.runtime = dependencies.runtime ?? new PlaywrightBrowserRuntime()
    this.adapters = dependencies.adapters ?? DEFAULT_ADAPTERS
    this.profileRoot = dependencies.profileRoot
    this.resolveExecutable = dependencies.resolveExecutable ?? resolveBrowserExecutable
    this.now = dependencies.now ?? (() => new Date().toISOString())
    this.snapshot = { status: 'idle', source: 'visible_browser', updatedAt: this.now() }
  }

  getSnapshot() {
    return structuredClone(this.snapshot)
  }

  open(target: BrowserPublishTarget) {
    return this.serialize(async () => {
      let normalized: BrowserPublishTarget | undefined
      try {
        normalized = normalizeTarget(target)
        if (this.session && this.active && this.snapshot.status === 'awaiting_user_submit') {
          if (sameTarget(this.active, normalized)) return this.getSnapshot()
          this.snapshot = {
            ...this.snapshot,
            error: {
              code: 'browser_active_draft',
              message: '当前平台还有待你确认的发布草稿。请先在浏览器中完成或放弃，再结束当前会话。',
            },
            updatedAt: this.now(),
          }
          return this.getSnapshot()
        }
        const draft = await this.loadAndValidateDraft(normalized)
        const adapter = this.adapters[normalized.platformId]
        this.setSnapshot('opening', normalized)
        await this.closeSessionOnly()
        const executablePath = await this.resolveExecutable()
        const profilePath = await this.resolveProfilePath(normalized.platformId)
        this.session = await this.runtime.openPersistentContext({ executablePath, profilePath })
        this.active = { ...normalized, draft }
        this.watchSessionClosed(this.session, normalized)
        await adapter.open(this.session.page)
        const readiness = await adapter.inspect(this.session.page)
        return this.setSnapshot(readiness, normalized, adapter.publishPageUrl)
      } catch (error) {
        await this.closeSessionOnly().catch(() => undefined)
        this.active = undefined
        return this.fail(error, normalized)
      }
    })
  }

  refresh() {
    return this.serialize(async () => {
      if (!this.session || !this.active) return this.fail(new BrowserPublishServiceError('browser_not_open', '浏览器发布页面尚未打开。'))
      try {
        const adapter = this.adapters[this.active.platformId]
        const readiness = await adapter.inspect(this.session.page)
        return this.setSnapshot(readiness, this.active, adapter.publishPageUrl)
      } catch (error) {
        return this.fail(error, this.active)
      }
    })
  }

  fill(target?: BrowserPublishTarget) {
    return this.serialize(async () => {
      if (!this.session || !this.active) return this.fail(new BrowserPublishServiceError('browser_not_open', '浏览器发布页面尚未打开。'))
      try {
        const normalizedTarget = target ? normalizeTarget(target) : normalizeTarget(this.active)
        if (!sameTarget(this.active, normalizedTarget)) {
          return this.fail(new BrowserPublishServiceError('browser_target_mismatch', '当前浏览器页面与所选发布包不一致。'), this.active)
        }
        // project.json may have changed while the user was logging in. Re-read
        // the committed package before touching the platform form.
        const draft = await this.loadAndValidateDraft(normalizedTarget)
        this.active = { ...normalizedTarget, draft }
        const adapter = this.adapters[this.active.platformId]
        const readiness = await adapter.inspect(this.session.page)
        if (readiness === 'login_required') {
          return this.setSnapshot('login_required', this.active, adapter.publishPageUrl)
        }
        this.setSnapshot('filling', this.active, adapter.publishPageUrl)
        await adapter.fillDraft(this.session.page, this.active.draft)
        return this.setSnapshot('awaiting_user_submit', this.active, adapter.publishPageUrl)
      } catch (error) {
        return this.fail(error, this.active)
      }
    })
  }

  close() {
    return this.serialize(async () => {
      const target = this.active
      try {
        await this.closeSessionOnly()
        this.active = undefined
        return this.setSnapshot('closed', target)
      } catch (error) {
        this.active = undefined
        return this.fail(error, target)
      }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  private async loadAndValidateDraft(target: BrowserPublishTarget): Promise<BrowserPublishDraft> {
    const workspace = await ensureProjectWorkspace(target.projectId, 'digital-human')
    const artifact = await getCurrentPublishArtifact(workspace, target.artifactId)
    const platform = artifact.platforms.find((item) => item.platformId === target.platformId)
    if (!platform) throw new BrowserPublishServiceError('publish_platform_missing', '发布包不包含所选平台。')
    const videoPath = await validateWorkspaceFile(workspace.rootPath, artifact.videoPath)
    const coverPath = artifact.coverPath
      ? await validateWorkspaceFile(workspace.rootPath, artifact.coverPath)
      : undefined
    return {
      platformId: target.platformId,
      publishPageUrl: platform.publishPageUrl,
      title: platform.title,
      description: platform.description,
      tags: platform.tags,
      videoPath,
      coverPath,
    }
  }

  private async resolveProfilePath(platformId: BrowserPublishTarget['platformId']) {
    const configuredRoot = this.profileRoot ?? process.env.KOUBO_BROWSER_PROFILE_ROOT?.trim()
    if (!configuredRoot) {
      throw new BrowserPublishServiceError('browser_profile_root_missing', '尚未配置浏览器发布数据目录。')
    }
    const root = path.resolve(configuredRoot)
    if (!this.profileRoot && process.env.DESKTOP_BACKEND_MODE === 'sidecar') {
      const appDataRoot = process.env.KOUBO_APP_DATA_ROOT?.trim()
      if (!appDataRoot) {
        throw new BrowserPublishServiceError('browser_profile_root_missing', '桌面应用数据目录不可用。')
      }
      try {
        assertInsideRoot(path.resolve(appDataRoot), root)
      } catch {
        throw new BrowserPublishServiceError('browser_profile_path_escape', '浏览器登录目录必须位于桌面应用数据目录内。')
      }
    }
    await fs.mkdir(root, { recursive: true })
    const profilePath = assertInsideRoot(root, path.join(root, platformId))
    await fs.mkdir(profilePath, { recursive: true })
    return profilePath
  }

  private async closeSessionOnly() {
    const session = this.session
    this.session = undefined
    this.unsubscribeSessionClosed?.()
    this.unsubscribeSessionClosed = undefined
    if (session) await session.close()
  }

  private watchSessionClosed(session: BrowserSession, target: BrowserPublishTarget) {
    this.unsubscribeSessionClosed = session.onClosed?.(() => {
      if (this.session !== session) return
      this.session = undefined
      this.unsubscribeSessionClosed = undefined
      this.active = undefined
      this.fail(new BrowserPublishServiceError(
        'browser_closed_unexpectedly',
        '浏览器窗口已关闭，请重新打开发布页面。',
      ), target)
    })
  }

  private setSnapshot(
    status: BrowserPublishSnapshot['status'],
    target?: Pick<BrowserPublishTarget, 'projectId' | 'artifactId' | 'platformId'>,
    pageUrl?: string,
  ) {
    this.snapshot = {
      status,
      source: 'visible_browser',
      platformId: target?.platformId,
      projectId: target?.projectId,
      artifactId: target?.artifactId,
      pageUrl,
      updatedAt: this.now(),
    }
    return this.getSnapshot()
  }

  private fail(error: unknown, target?: Pick<BrowserPublishTarget, 'projectId' | 'artifactId' | 'platformId'>) {
    const normalized = normalizeError(error)
    this.snapshot = {
      status: 'failed',
      source: 'visible_browser',
      platformId: target?.platformId,
      projectId: target?.projectId,
      artifactId: target?.artifactId,
      error: normalized,
      updatedAt: this.now(),
    }
    return this.getSnapshot()
  }
}

async function validateWorkspaceFile(workspaceRoot: string, filePath: string) {
  try {
    const lexicalPath = assertInsideRoot(workspaceRoot, filePath)
    const [realRoot, realFile, stat] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(lexicalPath),
      fs.stat(lexicalPath),
    ])
    assertInsideRoot(realRoot, realFile)
    if (!stat.isFile() || stat.size <= 0) throw new Error('empty')
    return realFile
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new BrowserPublishServiceError('publish_video_path_escape', '发布视频路径越过了当前 workspace。')
    }
    throw new BrowserPublishServiceError('publish_video_missing', '发布视频不存在或为空。')
  }
}

function normalizeTarget(target: BrowserPublishTarget): BrowserPublishTarget {
  if (!isPublishPlatformId(target.platformId)) {
    throw new BrowserPublishServiceError('browser_platform_unsupported', '仅支持抖音和小红书。')
  }
  return {
    projectId: assertSafeSegment(target.projectId, 'projectId'),
    artifactId: assertSafeSegment(target.artifactId, 'artifactId'),
    platformId: target.platformId,
  }
}

function sameTarget(left: BrowserPublishTarget, right: BrowserPublishTarget) {
  return left.projectId === right.projectId && left.artifactId === right.artifactId && left.platformId === right.platformId
}

function normalizeError(error: unknown) {
  if (
    error instanceof BrowserPublishServiceError ||
    error instanceof BrowserAdapterError ||
    error instanceof BrowserRuntimeError
  ) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof WorkspaceGuardError) return { code: 'workspace_guard', message: error.message }
  if (error instanceof PublishArtifactAccessError) return { code: error.code, message: error.message }
  return { code: 'browser_publish_failed', message: error instanceof Error ? error.message : '浏览器发布操作失败。' }
}

export class BrowserPublishServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserPublishServiceError'
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __kouboBrowserPublishService: BrowserPublishService | undefined
}

export function getBrowserPublishService() {
  globalThis.__kouboBrowserPublishService ??= new BrowserPublishService()
  return globalThis.__kouboBrowserPublishService
}
