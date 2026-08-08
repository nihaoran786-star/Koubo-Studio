import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { assertInsideRoot } from '@/lib/workspaces/workspace-guard'

const FILE_INPUT = '.cc-preview-stage input[type=file]'
const EXPORT_BUTTON = 'button[title="导出 MP4"]'
const EXPORT_QA = '.cc-export-qa-toggle input'
const EXPORT_CTA = '.cc-export-cta'

export class OpenChatCutCdpError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OpenChatCutCdpError'
  }
}

interface CdpAdapterOptions {
  chromium?: Pick<typeof chromium, 'connectOverCDP'>
  timeoutMs?: number
  probeExportMedia?: typeof probeOpenChatCutExport
  requireExactProject?: boolean
}

interface ProbeOptions {
  timeoutMs?: number
  spawnProcess?: typeof spawn
  platform?: NodeJS.Platform
}

export interface OpenChatCutExportMedia {
  durationSeconds: number
  codec: 'h264'
}

export interface OpenChatCutTranscriptionStatus {
  status: 'running' | 'succeeded' | 'failed' | 'not_found'
  errorCode?: 'auth' | 'network' | 'unknown'
}

export async function openOpenChatCutProjectEditor(input: {
  cdpPort: number
  editorUrl: string
  openChatCutProjectId: string
}, options: CdpAdapterOptions = {}) {
  const { browser } = await connectEditorPage(input, options)
  try {
    return { status: 'ok' as const }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export async function importOpenChatCutSource(input: {
  cdpPort: number
  editorUrl: string
  openChatCutProjectId: string
  workspaceRoot: string
  sourcePath: string
  timelineEmptyConfirmed: true
}, options: CdpAdapterOptions = {}) {
  if (input.timelineEmptyConfirmed !== true) {
    throw new OpenChatCutCdpError('timeline_not_confirmed_empty', '未确认空时间线，拒绝自动导入。')
  }
  const sourcePath = await canonicalWorkspaceFile(input.workspaceRoot, input.sourcePath)
  const { browser, page } = await connectEditorPage(input, options)
  try {
    const normalize = page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/normalize-media'
      } catch {
        return false
      }
    }, { timeout: options.timeoutMs ?? 180_000 })
    await page.locator(FILE_INPUT).setInputFiles(sourcePath)
    const response = await normalize
    if (!response.ok()) {
      throw new OpenChatCutCdpError('normalize_media_failed', `OpenChatCut 媒体标准化返回 HTTP ${response.status()}。`)
    }
    return { status: 'ok' as const }
  } catch (error) {
    if (error instanceof OpenChatCutCdpError) throw error
    throw new OpenChatCutCdpError('automatic_import_failed', error instanceof Error ? error.message : '自动导入失败。')
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export async function inspectOpenChatCutTranscriptionStatus(input: {
  cdpPort: number
  editorUrl: string
  openChatCutProjectId: string
  expectedSrc: string
}, options: CdpAdapterOptions = {}): Promise<OpenChatCutTranscriptionStatus> {
  if (
    !input.expectedSrc.startsWith('/media/uploads/') ||
    input.expectedSrc.startsWith('blob:')
  ) {
    throw new OpenChatCutCdpError(
      'transcription_asset_mismatch',
      '当前视频不是可核对的 OpenChatCut 本地媒体。',
    )
  }
  const { browser, page } = await connectEditorPage(input, {
    ...options,
    requireExactProject: true,
  })
  try {
    const observed = await page.evaluate(async ({ projectId, expectedSrc }) => {
      const databases = await indexedDB.databases()
      const database = databases.filter((candidate) =>
        candidate.name === 'openchatcut' && candidate.version === 1)
      if (database.length !== 1) throw new Error('database_mismatch')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openchatcut')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('database_open_failed'))
      })
      try {
        if (!db.objectStoreNames.contains('kv')) throw new Error('store_missing')
        const project = await new Promise<unknown>((resolve, reject) => {
          const transaction = db.transaction('kv', 'readonly')
          const request = transaction.objectStore('kv').get(`project:${projectId}`)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(new Error('project_read_failed'))
        })
        if (!project || typeof project !== 'object') throw new Error('project_missing')
        const assets = (project as { assets?: unknown }).assets
        if (!Array.isArray(assets)) throw new Error('assets_invalid')
        const matches = assets.filter((candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          (candidate as { src?: unknown }).src === expectedSrc)
        if (matches.length !== 1) throw new Error('asset_mismatch')
        const asset = matches[0] as {
          id?: unknown
          transcribeStatus?: unknown
          transcribeError?: unknown
          transcript?: unknown
        }
        if (
          typeof asset.id !== 'string' ||
          !/^[A-Za-z0-9._~-]+$/.test(asset.id)
        ) throw new Error('asset_id_invalid')
        if (asset.transcribeStatus === 'running') return { status: 'running' as const }
        if (
          asset.transcribeStatus === 'done' ||
          (Array.isArray(asset.transcript) && asset.transcript.length > 0)
        ) return { status: 'succeeded' as const }
        if (asset.transcribeStatus === undefined || asset.transcribeStatus === null) {
          return { status: 'not_found' as const }
        }
        if (asset.transcribeStatus !== 'failed') throw new Error('status_invalid')
        const error = typeof asset.transcribeError === 'string' ? asset.transcribeError : ''
        const errorCode = /(?:\bhttp\s*401\b|\b401\b|unauthori[sz]ed|authentication|invalid[\s_-]*(?:api[\s_-]*)?key)/i
          .test(error)
          ? 'auth'
          : /(?:network|fetch|connect|timeout|dns|econn|socket)/i.test(error)
            ? 'network'
            : 'unknown'
        return { status: 'failed' as const, errorCode }
      } finally {
        db.close()
      }
    }, {
      projectId: input.openChatCutProjectId,
      expectedSrc: input.expectedSrc,
    })
    if (
      !observed ||
      typeof observed !== 'object' ||
      !['running', 'succeeded', 'failed', 'not_found'].includes(observed.status) ||
      (
        observed.status === 'failed' &&
        !['auth', 'network', 'unknown'].includes(observed.errorCode ?? '')
      )
    ) {
      throw new OpenChatCutCdpError(
        'transcription_state_invalid',
        'OpenChatCut 返回了无法核对的转写状态。',
      )
    }
    if (observed.status === 'failed') {
      return {
        status: 'failed',
        errorCode: observed.errorCode as 'auth' | 'network' | 'unknown',
      }
    }
    return { status: observed.status as 'running' | 'succeeded' | 'not_found' }
  } catch (error) {
    if (error instanceof OpenChatCutCdpError) throw error
    throw new OpenChatCutCdpError(
      'transcription_state_unavailable',
      '无法安全读取当前 OpenChatCut 项目的转写状态。',
    )
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export async function exportOpenChatCutVideo(input: {
  cdpPort: number
  editorUrl: string
  openChatCutProjectId: string
  workspaceRoot: string
  artifactId: string
}, options: CdpAdapterOptions = {}) {
  const outputRoot = assertInsideRoot(
    input.workspaceRoot,
    path.join(input.workspaceRoot, 'artifacts', 'post-production'),
  )
  await fs.mkdir(outputRoot, { recursive: true })
  const canonicalWorkspace = await fs.realpath(input.workspaceRoot)
  const canonicalOutputRoot = await fs.realpath(outputRoot)
  assertCanonicalInside(canonicalWorkspace, canonicalOutputRoot)
  const partPath = assertInsideRoot(outputRoot, path.join(outputRoot, `.openchatcut-${input.artifactId}.part`))
  const finalPath = assertInsideRoot(outputRoot, path.join(outputRoot, `${input.artifactId}.mp4`))
  const { browser, page } = await connectEditorPage(input, options)
  try {
    await page.locator(EXPORT_BUTTON).click()
    const qa = page.locator(EXPORT_QA)
    await qa.waitFor({ state: 'visible', timeout: options.timeoutMs ?? 30_000 })
    if (!await qa.isChecked()) await qa.check()
    const downloadPromise = page.waitForEvent('download', { timeout: options.timeoutMs ?? 10 * 60_000 })
    await page.locator(EXPORT_CTA).click()
    const download = await downloadPromise
    if (path.extname(download.suggestedFilename()).toLowerCase() !== '.mp4') {
      throw new OpenChatCutCdpError('invalid_export_format', 'OpenChatCut 导出结果不是 MP4。')
    }
    await download.saveAs(partPath)
    const failure = await download.failure()
    if (failure) throw new OpenChatCutCdpError('export_download_failed', failure)
    const stat = await fs.stat(partPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new OpenChatCutCdpError('export_empty', 'OpenChatCut 导出的 MP4 为空。')
    }
    const handle = await fs.open(partPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    const probed = await (options.probeExportMedia ?? probeOpenChatCutExport)(partPath)
    await fs.rename(partPath, finalPath)
    return { status: 'ok' as const, outputPath: finalPath, durationSeconds: probed.durationSeconds }
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => undefined)
    if (error instanceof OpenChatCutCdpError) throw error
    throw new OpenChatCutCdpError('automatic_export_failed', error instanceof Error ? error.message : '自动导出失败。')
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export function probeOpenChatCutExport(
  filePath: string,
  options: ProbeOptions = {},
): Promise<OpenChatCutExportMedia> {
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn
    const child = spawnProcess(process.env.FFPROBE_PATH?.trim() || 'ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=codec_name,codec_type',
      '-of', 'json',
      filePath,
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', () => settle(() =>
      reject(new OpenChatCutCdpError('media_probe_failed', '无法验证导出视频。'))))
    child.once('close', (code) => settle(() => {
      if (code !== 0) {
        reject(new OpenChatCutCdpError('media_probe_failed', stderr.trim() || '无法验证导出视频流。'))
        return
      }
      try {
        const parsed = JSON.parse(stdout) as {
          format?: { duration?: unknown }
          streams?: Array<{ codec_name?: unknown; codec_type?: unknown }>
        }
        const durationSeconds = Number(parsed.format?.duration)
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          reject(new OpenChatCutCdpError('media_duration_invalid', 'OpenChatCut 导出结果没有有效时长。'))
          return
        }
        const stream = parsed.streams?.find((item) => item.codec_type === 'video')
        if (!stream || typeof stream.codec_name !== 'string') {
          reject(new OpenChatCutCdpError('video_stream_missing', 'OpenChatCut 导出结果没有有效视频流。'))
          return
        }
        if (stream.codec_name.toLowerCase() !== 'h264') {
          reject(new OpenChatCutCdpError('export_codec_invalid', 'OpenChatCut 导出结果不是 H.264 视频。'))
          return
        }
        resolve({ codec: 'h264', durationSeconds })
      } catch {
        reject(new OpenChatCutCdpError('media_probe_failed', 'OpenChatCut 导出视频探测结果无效。'))
      }
    }))
    timeout = setTimeout(() => {
      if (settled) return
      terminateProbeProcess(child, options.platform ?? process.platform, spawnProcess)
      settle(() => reject(new OpenChatCutCdpError(
        'media_probe_timeout',
        'OpenChatCut 导出视频校验超时，请重试。',
      )))
    }, options.timeoutMs ?? 30_000)
  })
}

function terminateProbeProcess(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
) {
  if (platform !== 'win32' || !child.pid) {
    try { child.kill('SIGTERM') } catch { /* process already exited */ }
    return
  }
  const killer = spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  const fallback = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer)
    try { child.kill() } catch { /* process already exited */ }
  }
  killer.once('error', fallback)
  killer.once('close', (code) => {
    if (code !== 0) fallback()
    else if (fallbackTimer) clearTimeout(fallbackTimer)
  })
  fallbackTimer = setTimeout(fallback, 1_000)
  fallbackTimer.unref?.()
}

async function connectEditorPage(
  input: { cdpPort: number; editorUrl: string; openChatCutProjectId: string },
  options: CdpAdapterOptions,
) {
  if (!Number.isInteger(input.cdpPort) || input.cdpPort < 1024 || input.cdpPort > 65535) {
    throw new OpenChatCutCdpError('cdp_port_missing', 'OpenChatCut 没有有效的受管 CDP 端口，请从应用重新启动。')
  }
  const expected = validateOpenChatCutEditorUrl(input.editorUrl, input.openChatCutProjectId)
  const endpoint = `http://127.0.0.1:${input.cdpPort}`
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>
  try {
    browser = await (options.chromium ?? chromium).connectOverCDP(endpoint, {
      timeout: options.timeoutMs ?? 15_000,
    })
  } catch {
    throw new OpenChatCutCdpError('cdp_unavailable', '无法连接受管 OpenChatCut 窗口，请从应用重新启动剪辑器。')
  }
  try {
    const pages = browser.contexts().flatMap((context) => context.pages())
    const candidates = pages.filter((candidate) => isManagedTargetUrl(candidate.url(), expected))
    const openChatCutPages = []
    for (const candidate of candidates) {
      const title = await candidate.title().catch(() => '')
      if (title.trim().toLowerCase().includes('openchatcut')) openChatCutPages.push(candidate)
    }
    if (openChatCutPages.length !== 1) {
      throw new OpenChatCutCdpError('cdp_target_mismatch', '受管窗口不是当前 OpenChatCut 编辑器。')
    }
    const page = openChatCutPages[0]
    if (options.requireExactProject && page.url() !== expected.toString()) {
      throw new OpenChatCutCdpError(
        'editor_navigation_mismatch',
        '当前可见 OpenChatCut 窗口不是预期项目。',
      )
    }
    if (page.url() !== `${expected.origin}/` && page.url() !== expected.toString()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30_000 })
    }
    await page.goto(expected.toString(), { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 30_000 })
    if (page.url() !== expected.toString()) {
      throw new OpenChatCutCdpError('editor_navigation_mismatch', 'OpenChatCut 编辑器跳转到了非预期项目。')
    }
    return { browser, page }
  } catch (error) {
    await browser.close().catch(() => undefined)
    if (error instanceof OpenChatCutCdpError) throw error
    throw new OpenChatCutCdpError(
      'editor_navigation_failed',
      '无法打开当前 OpenChatCut 项目，请确认可见剪辑窗口正常后重试。',
    )
  }
}

export function validateOpenChatCutEditorUrl(value: string, projectId: string) {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash !== `#/editor/${encodeURIComponent(projectId)}`
  ) {
    throw new OpenChatCutCdpError('invalid_editor_url', '专业剪辑器返回了无效的本机编辑地址。')
  }
  return url
}

function isManagedTargetUrl(value: string, expected: URL) {
  try {
    const target = new URL(value)
    if (
      target.protocol !== 'http:' ||
      target.origin !== expected.origin ||
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.search
    ) return false
    return !target.hash ||
      target.hash === '#/' ||
      /^#\/editor\/[A-Za-z0-9._~-]+$/.test(target.hash)
  } catch {
    return false
  }
}

async function canonicalWorkspaceFile(workspaceRoot: string, filePath: string) {
  const [canonicalWorkspace, canonicalFile] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(assertInsideRoot(workspaceRoot, filePath)),
  ])
  assertCanonicalInside(canonicalWorkspace, canonicalFile)
  const stat = await fs.stat(canonicalFile)
  if (!stat.isFile()) throw new OpenChatCutCdpError('source_video_missing', '当前视频文件不存在。')
  return canonicalFile
}

function assertCanonicalInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new OpenChatCutCdpError('workspace_path_escape', 'OpenChatCut 文件路径超出当前 workspace。')
  }
}
