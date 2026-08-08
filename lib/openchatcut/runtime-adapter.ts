import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getRuntimeDataRoot } from '@/lib/runtime-data/runtime-data-root'
import { readOpenChatCutSettings, writeOpenChatCutSettings } from './settings-store'
import type { OpenChatCutResult, OpenChatCutRuntimeStatus } from './types'

export const OPENCHATCUT_VERSION = '0.1.6'
export const OPENCHATCUT_REPOSITORY = '0xsline/OpenChatCut'
export const OPENCHATCUT_INSTALLER_NAME = `OpenChatCut-${OPENCHATCUT_VERSION}-x64.exe`
export const OPENCHATCUT_INSTALLER_SHA256 = '15542724e438d3500d1f16651310592102b16850c07a6200c0f953df6c401624'
const RELEASE_BASE = `https://github.com/${OPENCHATCUT_REPOSITORY}/releases/download/v${OPENCHATCUT_VERSION}`
export const OPENCHATCUT_INSTALLER_URL = `${RELEASE_BASE}/${OPENCHATCUT_INSTALLER_NAME}`
const MCP_URL = 'http://127.0.0.1:5199/api/external-mcp/mcp'
const DOWNLOAD_STALLED_MS = 15_000

interface DownloadState {
  received: number
  total?: number
  updatedAt: number
  promise: Promise<OpenChatCutResult<{ installerPath: string }>>
}

interface DownloadRuntimeState {
  activeDownload?: DownloadState
  lastDownloadError?: { code: string; message: string }
}

const downloadRuntimeStates = new Map<string, DownloadRuntimeState>()
let activeInstaller: ReturnType<typeof spawn> | undefined
let activeInstallerSpawn: Promise<void> | undefined
let installerValidityCache:
  | { identity: string; valid: boolean }
  | undefined
let installerValidationInFlight:
  | { identity: string; promise: Promise<boolean> }
  | undefined
let installerValidationEpoch = 0

const REQUIRED_INSTALLATION_PAYLOAD = [
  'resources/app/package.json',
  'resources/app/desktop-dist/main.mjs',
  'resources/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js',
  'resources/app/node_modules/zod/v3/index.js',
  'resources/app/node_modules/zod/v4-mini/index.js',
] as const

export async function inspectOpenChatCutRuntime(
  fetcher: typeof fetch = fetch,
  dependencies: { hash?: typeof hashFile } = {},
): Promise<OpenChatCutRuntimeStatus> {
  const downloadState = getDownloadRuntimeState()
  const activeDownloadAtEntry = downloadState.activeDownload
  const [installation, installerReady, settings] = await Promise.all([
    inspectInstallation(),
    validInstallerExists(dependencies.hash),
    readOpenChatCutSettings(),
  ])
  const [mcpProbe, managedCdp] = await Promise.all([
    probeMcp(fetcher, settings.bearerToken),
    probeManagedCdp(fetcher, settings.cdpPort),
  ])
  if (mcpProbe === 'auth_error') {
    return {
      ...status('failed', installation.ready, installerReady, false, '专业剪辑器访问令牌不匹配。'),
      error: { code: 'auth_error', message: '专业剪辑器访问令牌不匹配。' },
    }
  }
  if (managedCdp && mcpProbe === 'ready') {
    return status('mcp_ready', installation.ready, installerReady, true, '专业剪辑器已启动，可以创建编辑项目。')
  }
  if (managedCdp) {
    return status(
      'launching',
      installation.ready,
      installerReady,
      false,
      'OpenChatCut 窗口已启动，正在连接本地 MCP…',
    )
  }
  if (mcpProbe === 'ready') {
    return {
      ...status(
        'external_instance',
        installation.ready,
        installerReady,
        false,
        '检测到另一个 OpenChatCut 实例；请关闭它，再从口播智能体启动。',
      ),
      error: {
        code: 'external_instance',
        message: '本地 MCP 正在运行，但无法验证为口播智能体启动的 OpenChatCut 窗口。',
      },
    }
  }
  if (activeInstaller) {
    return status('installing', false, installerReady, false, 'OpenChatCut 安装器正在运行，请完成安装后稍候。')
  }
  if (!installation.ready && downloadState.lastDownloadError) {
    return {
      ...status('failed', false, false, false, downloadState.lastDownloadError.message),
      error: downloadState.lastDownloadError,
    }
  }
  if (!installation.ready && activeDownloadAtEntry) {
    const total = activeDownloadAtEntry.total
    return {
      ...status('downloading', false, false, false, '正在后台下载专业剪辑器安装包…'),
      download: {
        received: activeDownloadAtEntry.received,
        ...(total ? { total, percent: Math.min(100, Math.floor(activeDownloadAtEntry.received / total * 100)) } : {}),
        stalled: Date.now() - activeDownloadAtEntry.updatedAt >= DOWNLOAD_STALLED_MS,
      },
    }
  }
  if (installation.executable && !installation.ready) {
    return {
      ...status(
        'failed',
        false,
        installerReady,
        false,
        installerReady
          ? 'OpenChatCut 安装不完整，可使用已校验安装包修复。'
          : 'OpenChatCut 安装不完整，请重新下载安装包修复。',
      ),
      error: {
        code: 'install_incomplete',
        message: '检测到不完整的 OpenChatCut 安装，关键运行文件缺失。',
      },
    }
  }
  if (installation.ready) return status('installed', true, installerReady, false, '已安装，启动后即可进入专业剪辑。')
  if (installerReady) return status('installer_ready', false, true, false, '安装包已校验，请完成一次可见安装。')
  return status('not_installed', false, false, false, '尚未安装；需要时可自动下载官方安装包。')
}

export function downloadOpenChatCutInstaller(fetcher: typeof fetch = fetch) {
  const root = downloadsRoot()
  const runtimeState = getDownloadRuntimeState(root)
  if (runtimeState.activeDownload) return runtimeState.activeDownload.promise
  runtimeState.lastDownloadError = undefined
  const state = {} as DownloadState
  state.received = 0
  state.updatedAt = Date.now()
  state.promise = performDownload(fetcher, state, root)
    .then((result) => {
      runtimeState.lastDownloadError = result.status === 'error' ? result.error : undefined
      return result
    })
    .finally(() => {
      if (runtimeState.activeDownload === state) runtimeState.activeDownload = undefined
    })
  runtimeState.activeDownload = state
  return state.promise
}

export function startOpenChatCutInstallerDownload(fetcher: typeof fetch = fetch) {
  void downloadOpenChatCutInstaller(fetcher).catch(() => undefined)
}

export async function launchOpenChatCut(
  target: 'installer' | 'app',
  dependencies: {
    spawnProcess?: typeof spawn
    hash?: typeof hashFile
  } = {},
): Promise<OpenChatCutResult> {
  const installation = target === 'app' ? await inspectInstallation() : undefined
  if (target === 'app' && installation?.executable && !installation.ready) {
    return failure('install_incomplete', 'OpenChatCut 安装不完整，请修复安装后重试。')
  }
  const filePath = target === 'installer' ? installerPath() : installation?.executable
  if (!filePath || !(await regularFile(filePath))) {
    return failure(target === 'installer' ? 'installer_missing' : 'app_not_installed', target === 'installer'
      ? '安装包尚未下载并校验。'
      : '尚未找到 OpenChatCut，请先完成安装。')
  }
  if (target === 'installer' && await (dependencies.hash ?? hashFile)(filePath) !== OPENCHATCUT_INSTALLER_SHA256) {
    await fsp.rm(filePath, { force: true }).catch(() => undefined)
    invalidateInstallerValidityCache()
    return failure('checksum_mismatch', '安装包启动前校验失败，已删除损坏文件，请重新下载。')
  }
  try {
    if (target === 'installer') {
      if (activeInstaller) {
        if (activeInstallerSpawn) await activeInstallerSpawn
        return { status: 'ok', source: 'openchatcut' }
      }
      const child = (dependencies.spawnProcess ?? spawn)(
        filePath,
        [],
        { detached: true, stdio: 'ignore', windowsHide: false },
      )
      activeInstaller = child
      const clear = () => {
        if (activeInstaller === child) activeInstaller = undefined
      }
      child.once('exit', clear)
      child.once('error', clear)
      const spawnConfirmation = confirmProcessSpawn(child)
      activeInstallerSpawn = spawnConfirmation
      try {
        await spawnConfirmation
      } finally {
        if (activeInstallerSpawn === spawnConfirmation) activeInstallerSpawn = undefined
      }
      child.unref()
      return { status: 'ok', source: 'openchatcut' }
    }
    const settings = await readOpenChatCutSettings()
    const cdpPort = await reserveLoopbackPort()
    const bearerToken = settings.bearerToken ?? randomBytes(32).toString('base64url')
    await writeOpenChatCutSettings({ ...settings, version: 2, bearerToken, cdpPort })
    const env = { ...process.env }
    delete env.OPENCHATCUT_EDITOR_URL
    delete env.OPENCHATCUT_MCP_TOKEN
    env.OPENCHATCUT_MCP_TOKEN = bearerToken
    const child = (dependencies.spawnProcess ?? spawn)(filePath, [
      `--remote-debugging-port=${cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
    ], { detached: true, stdio: 'ignore', windowsHide: false, env })
    guardProcessErrorsUntilClose(child)
    await confirmProcessSpawn(child)
    child.unref()
    return { status: 'ok', source: 'openchatcut' }
  } catch {
    return failure('launch_failed', target === 'installer' ? '无法打开安装程序，请重试。' : '无法启动专业剪辑器，请重试。')
  }
}

export function assertOfficialReleaseUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('只允许 GitHub 官方发布地址。')
  const expected = `/0xsline/OpenChatCut/releases/download/v${OPENCHATCUT_VERSION}/`
  if (!url.pathname.startsWith(expected) || path.posix.basename(url.pathname) !== OPENCHATCUT_INSTALLER_NAME) {
    throw new Error('发布地址不属于固定 OpenChatCut 版本。')
  }
}

async function performDownload(
  fetcher: typeof fetch,
  state: DownloadState,
  root: string,
): Promise<OpenChatCutResult<{ installerPath: string }>> {
  const destination = path.join(root, OPENCHATCUT_INSTALLER_NAME)
  await fsp.mkdir(root, { recursive: true })
  await cleanupVersionTemporaryFiles(root)
  const temporary = path.join(root, `.${OPENCHATCUT_INSTALLER_NAME}.${process.pid}.${Date.now()}.tmp`)
  const controller = new AbortController()
  let stalled = false
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, DOWNLOAD_STALLED_MS)
    stallTimer.unref()
  }
  try {
    assertOfficialReleaseUrl(OPENCHATCUT_INSTALLER_URL)
    armStallTimer()
    const response = await fetcher(OPENCHATCUT_INSTALLER_URL, {
      redirect: 'follow',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
    })
    if (!response.ok || !response.body) return failure('installer_download_failed', '无法下载官方安装包。')
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isSafeInteger(contentLength) && contentLength > 0) state.total = contentLength
    const hash = createHash('sha256')
    const tracker = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.byteLength(chunk)
        state.received += bytes
        state.updatedAt = Date.now()
        armStallTimer()
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as never),
      tracker,
      fs.createWriteStream(temporary, { flags: 'wx' }),
      { signal: controller.signal },
    )
    if (hash.digest('hex') !== OPENCHATCUT_INSTALLER_SHA256) {
      invalidateInstallerValidityCache()
      return failure('checksum_mismatch', '安装包校验失败，已删除不完整文件。')
    }
    invalidateInstallerValidityCache()
    await fsp.rm(destination, { force: true })
    await fsp.rename(temporary, destination)
    await cacheInstallerValidity(destination, true)
    return { status: 'ok', source: 'openchatcut', installerPath: destination }
  } catch (error) {
    invalidateInstallerValidityCache()
    if (stalled) return failure('download_stalled', '安装包下载长时间没有收到数据，请检查网络后重试。')
    return failure('download_failed', error instanceof Error ? error.message : '下载专业剪辑器失败。')
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function cleanupVersionTemporaryFiles(root = downloadsRoot()) {
  const names = await fsp.readdir(root).catch(() => [] as string[])
  await Promise.all(names
    .filter((name) => name.startsWith(`.${OPENCHATCUT_INSTALLER_NAME}.`) && name.endsWith('.tmp'))
    .map((name) => fsp.rm(path.join(root, name), { force: true })))
}

async function probeMcp(fetcher: typeof fetch, bearerToken?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`
  try {
    const response = await fetcher(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'koubo-agent-probe', version: '1' } },
      }),
      signal: AbortSignal.timeout(1200),
    })
    if (response.status === 401) return 'auth_error' as const
    return response.ok && response.headers.has('mcp-session-id') ? 'ready' as const : 'unavailable' as const
  } catch {
    return 'unavailable' as const
  }
}

async function probeManagedCdp(fetcher: typeof fetch, cdpPort?: number) {
  if (!Number.isInteger(cdpPort) || !cdpPort || cdpPort < 1024 || cdpPort > 65535) return false
  const baseUrl = `http://127.0.0.1:${cdpPort}`
  try {
    const [versionResponse, targetsResponse] = await Promise.all([
      fetcher(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(1200) }),
      fetcher(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(1200) }),
    ])
    if (!versionResponse.ok || !targetsResponse.ok) return false
    const version = await versionResponse.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof version.webSocketDebuggerUrl !== 'string') return false
    const debuggerUrl = new URL(version.webSocketDebuggerUrl)
    if (
      debuggerUrl.protocol !== 'ws:' ||
      !isLoopbackHostname(debuggerUrl.hostname) ||
      Number(debuggerUrl.port) !== cdpPort
    ) return false
    const targets = await targetsResponse.json() as unknown
    if (!Array.isArray(targets)) return false
    return targets.some((target) => {
      if (!target || typeof target !== 'object') return false
      const candidate = target as {
        type?: unknown
        title?: unknown
        url?: unknown
        webSocketDebuggerUrl?: unknown
      }
      if (
        candidate.type !== 'page' ||
        typeof candidate.title !== 'string' ||
        !candidate.title.toLowerCase().includes('openchatcut') ||
        typeof candidate.url !== 'string' ||
        !matchesManagedWebSocket(candidate.webSocketDebuggerUrl, cdpPort)
      ) return false
      try {
        const pageUrl = new URL(candidate.url)
        return (
          (pageUrl.protocol === 'http:' || pageUrl.protocol === 'https:') &&
          isLoopbackHostname(pageUrl.hostname)
        )
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

function isLoopbackHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function matchesManagedWebSocket(value: unknown, cdpPort: number) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' && isLoopbackHostname(url.hostname) && Number(url.port) === cdpPort
  } catch {
    return false
  }
}

async function inspectInstallation(): Promise<{ executable?: string; ready: boolean }> {
  const developmentOverride = process.env.NODE_ENV !== 'production'
    ? process.env.KOUBO_OPENCHATCUT_EXE?.trim()
    : undefined
  const roots = process.env.NODE_ENV !== 'production' && developmentOverride
    ? [path.dirname(developmentOverride)]
    : [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenChatCut'),
        'C:\\Program Files\\OpenChatCut',
        'C:\\Program Files (x86)\\OpenChatCut',
      ]
  for (const root of roots) {
    const candidate = developmentOverride && root === path.dirname(developmentOverride)
      ? developmentOverride
      : path.join(root, 'OpenChatCut.exe')
    if (!candidate || path.basename(candidate).toLowerCase() !== 'openchatcut.exe') continue
    const canonical = await canonicalInstalledCandidate(root, candidate)
    if (canonical) {
      return {
        executable: canonical,
        ready: await installationPayloadComplete(path.dirname(canonical)),
      }
    }
  }
  return { ready: false }
}

async function installationPayloadComplete(root: string) {
  const results = await Promise.all(REQUIRED_INSTALLATION_PAYLOAD.map((relative) =>
    regularNonEmptyFile(path.join(root, ...relative.split('/')))))
  return results.every(Boolean)
}

async function canonicalInstalledCandidate(root: string, candidate: string) {
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)])
    const relative = path.relative(canonicalRoot, canonicalCandidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
    return (await fsp.stat(canonicalCandidate)).isFile() ? canonicalCandidate : undefined
  } catch {
    return undefined
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function downloadsRoot() { return path.join(getRuntimeDataRoot(), 'runtimes', 'openchatcut', `v${OPENCHATCUT_VERSION}`) }
function installerPath() { return path.join(downloadsRoot(), OPENCHATCUT_INSTALLER_NAME) }
function getDownloadRuntimeState(root = downloadsRoot()) {
  const key = process.platform === 'win32'
    ? path.resolve(root).toLowerCase()
    : path.resolve(root)
  let state = downloadRuntimeStates.get(key)
  if (!state) {
    state = {}
    downloadRuntimeStates.set(key, state)
  }
  return state
}
async function validInstallerExists(hash: typeof hashFile = hashFile) {
  try {
    const identity = await installerFileIdentity(installerPath())
    if (!identity) {
      invalidateInstallerValidityCache()
      return false
    }
    if (installerValidityCache?.identity === identity) return installerValidityCache.valid
    if (installerValidationInFlight?.identity === identity) {
      return await installerValidationInFlight.promise
    }
    const validationEpoch = ++installerValidationEpoch
    const promise = hash(installerPath())
      .then((digest) => {
        const valid = digest === OPENCHATCUT_INSTALLER_SHA256
        if (installerValidationEpoch === validationEpoch) {
          installerValidityCache = { identity, valid }
        }
        return valid
      })
      .finally(() => {
        if (installerValidationInFlight?.promise === promise) installerValidationInFlight = undefined
      })
    installerValidationInFlight = { identity, promise }
    return await promise
  } catch {
    invalidateInstallerValidityCache()
    return false
  }
}
async function regularFile(filePath: string) { return fsp.stat(filePath).then((entry) => entry.isFile()).catch(() => false) }
async function regularNonEmptyFile(filePath: string) {
  return fsp.stat(filePath).then((entry) => entry.isFile() && entry.size > 0).catch(() => false)
}
async function hashFile(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}
async function installerFileIdentity(filePath: string) {
  try {
    const [canonical, entry] = await Promise.all([fsp.realpath(filePath), fsp.stat(filePath)])
    if (!entry.isFile()) return undefined
    return [
      canonical,
      entry.size,
      entry.mtimeMs,
      entry.ctimeMs,
      entry.ino,
    ].join('\u0000')
  } catch {
    return undefined
  }
}
async function cacheInstallerValidity(filePath: string, valid: boolean) {
  const identity = await installerFileIdentity(filePath)
  installerValidationEpoch += 1
  installerValidationInFlight = undefined
  installerValidityCache = identity ? { identity, valid } : undefined
}
function invalidateInstallerValidityCache() {
  installerValidationEpoch += 1
  installerValidityCache = undefined
  installerValidationInFlight = undefined
}
function confirmProcessSpawn(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      child.off('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}
function guardProcessErrorsUntilClose(child: ReturnType<typeof spawn>) {
  const onLateError = () => undefined
  const removeGuard = () => {
    child.off('error', onLateError)
    child.off('close', removeGuard)
  }
  child.on('error', onLateError)
  child.once('close', removeGuard)
}
function status(phase: OpenChatCutRuntimeStatus['phase'], installed: boolean, installerReady: boolean, mcpReady: boolean, detail: string): OpenChatCutRuntimeStatus {
  return { phase, installed, installerReady, mcpReady, detail, version: OPENCHATCUT_VERSION }
}
function failure(code: string, message: string): OpenChatCutResult<never> {
  return { status: 'error', source: 'openchatcut', error: { code, message } }
}
