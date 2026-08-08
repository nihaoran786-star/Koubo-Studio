import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const DEFAULT_SIZE_MIB = 12
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MIB = 1024 * 1024

export function readProductionStandaloneUploadSmokeConfig(env = process.env, root = process.cwd()) {
  const sizeMiB = readPositiveNumber(env.STANDALONE_UPLOAD_SMOKE_MIB, DEFAULT_SIZE_MIB)
  const startupTimeoutMs = readPositiveNumber(
    env.STANDALONE_UPLOAD_SMOKE_STARTUP_TIMEOUT_MS,
    DEFAULT_STARTUP_TIMEOUT_MS,
  )
  const requestTimeoutMs = readPositiveNumber(
    env.STANDALONE_UPLOAD_SMOKE_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
  )

  if (sizeMiB < DEFAULT_SIZE_MIB) {
    throw new Error(`STANDALONE_UPLOAD_SMOKE_MIB 不能小于 ${DEFAULT_SIZE_MIB}，否则无法跨过 Next 10 MiB 回归边界。`)
  }

  return {
    root,
    sizeMiB,
    sizeBytes: Math.floor(sizeMiB * MIB),
    startupTimeoutMs,
    requestTimeoutMs,
    standaloneRoot: path.join(root, '.next', 'standalone'),
    serverPath: path.join(root, '.next', 'standalone', 'server.js'),
  }
}

export async function runProductionStandaloneUploadSmoke({
  env = process.env,
  root = process.cwd(),
  fetcher = fetch,
  logger = console,
  launchServer = launchStandaloneServer,
  stopServer = stopStandaloneServer,
  createTempRoot = defaultCreateTempRoot,
  removeTempRoot = defaultRemoveTempRoot,
  reservePort = getAvailableLoopbackPort,
} = {}) {
  let config
  try {
    config = readProductionStandaloneUploadSmokeConfig(env, root)
  } catch (error) {
    return failure(logger, 'standalone_upload_invalid_config', error)
  }

  if (!(await fileExists(config.serverPath))) {
    return failure(
      logger,
      'standalone_artifact_missing',
      new Error('缺少 .next/standalone/server.js，请先运行 pnpm build:desktop:backend。'),
    )
  }

  let tempRoot
  let processHandle
  try {
    tempRoot = await createTempRoot()
    const workspaceRoot = path.join(tempRoot, 'workspaces')
    await fs.mkdir(workspaceRoot, { recursive: true })
    const sourcePath = path.join(tempRoot, `source-${config.sizeMiB}m.mp4`)
    await createSparseFile(sourcePath, config.sizeBytes)
    const sourceSha256 = await sha256File(sourcePath)
    const port = await reservePort()
    const baseUrl = `http://127.0.0.1:${port}`

    processHandle = launchServer({
      serverPath: config.serverPath,
      standaloneRoot: config.standaloneRoot,
      port,
      appDataRoot: tempRoot,
      workspaceRoot,
      env,
    })
    await waitForStandalone({
      baseUrl,
      timeoutMs: config.startupTimeoutMs,
      fetcher,
      processHandle,
    })

    const projectId = `standalone-upload-smoke-${Date.now().toString(36)}-${process.pid}`
    const endpoint = `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/edit-media-assets`
    const fixed = await uploadAndVerify({
      endpoint,
      filePath: sourcePath,
      expectedBytes: config.sizeBytes,
      expectedSha256: sourceSha256,
      mode: 'content-length',
      fetcher,
      timeoutMs: config.requestTimeoutMs,
    })
    const chunked = await uploadAndVerify({
      endpoint,
      filePath: sourcePath,
      expectedBytes: config.sizeBytes,
      expectedSha256: sourceSha256,
      mode: 'chunked',
      fetcher,
      timeoutMs: config.requestTimeoutMs,
    })

    const result = {
      status: 'ok',
      source: 'production_standalone_upload_smoke',
      sizeMiB: config.sizeMiB,
      sizeBytes: config.sizeBytes,
      sourceSha256,
      uploads: [fixed, chunked],
    }
    logger.log(
      `Production standalone upload smoke passed: ${config.sizeMiB} MiB content-length + chunked, SHA-256 verified.`,
    )
    return result
  } catch (error) {
    const serverOutput = processHandle?.getOutput?.()
    const suffix = serverOutput ? `\nStandalone output:\n${serverOutput}` : ''
    const wrapped = new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`)
    return failure(logger, 'standalone_upload_smoke_failed', wrapped)
  } finally {
    const cleanupErrors = []
    try {
      await stopServer(processHandle)
    } catch (error) {
      cleanupErrors.push(`停止 standalone 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (tempRoot) {
      try {
        await removeTempRoot(tempRoot)
      } catch (error) {
        cleanupErrors.push(`删除临时 AppData 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (cleanupErrors.length > 0) {
      return failure(logger, 'standalone_upload_cleanup_failed', new Error(cleanupErrors.join('; ')))
    }
  }
}

export async function uploadAndVerify({
  endpoint,
  filePath,
  expectedBytes,
  expectedSha256,
  mode,
  fetcher = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (mode !== 'content-length' && mode !== 'chunked') {
    throw new Error(`不支持的上传模式: ${mode}`)
  }

  const filename = `smoke-${mode}.mp4`
  const headers = {
    'content-type': 'video/mp4',
    'x-koubo-filename': encodeURIComponent(filename),
    'x-koubo-edit-kind': 'intro',
    ...(mode === 'content-length' ? { 'content-length': String(expectedBytes) } : {}),
  }
  const body = Readable.toWeb(createReadStream(filePath))
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json()
  if (!response.ok || payload?.status !== 'ok' || !payload?.asset) {
    throw new Error(`${mode} 上传失败: ${payload?.error?.message || `HTTP ${response.status}`}`)
  }

  const asset = payload.asset
  if (asset.size !== expectedBytes) {
    throw new Error(`${mode} asset.size 不匹配: 期望 ${expectedBytes}，实际 ${asset.size}`)
  }
  const stat = await fs.stat(asset.path)
  if (!stat.isFile() || stat.size !== expectedBytes) {
    throw new Error(`${mode} 磁盘文件大小不匹配: 期望 ${expectedBytes}，实际 ${stat.size}`)
  }
  const savedSha256 = await sha256File(asset.path)
  if (savedSha256 !== expectedSha256) {
    throw new Error(`${mode} SHA-256 不匹配: 期望 ${expectedSha256}，实际 ${savedSha256}`)
  }

  return {
    mode,
    status: 'ok',
    assetId: asset.assetId,
    bytes: stat.size,
    sha256: savedSha256,
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex').toUpperCase()
}

export async function getAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      server.close((error) => {
        if (error) reject(error)
        else if (!port) reject(new Error('无法分配本机随机端口。'))
        else resolve(port)
      })
    })
  })
}

export function launchStandaloneServer({
  serverPath,
  standaloneRoot,
  port,
  appDataRoot,
  workspaceRoot,
  env,
}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: standaloneRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      KOUBO_APP_DATA_ROOT: appDataRoot,
      KOUBO_WORKSPACES_ROOT: workspaceRoot,
    },
  })
  let output = ''
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-32_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return {
    child,
    pid: child.pid,
    getOutput: () => output.trim(),
  }
}

export async function stopStandaloneServer(processHandle) {
  const child = processHandle?.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  child.kill('SIGTERM')
  if (await waitForExit(child, 3_000)) return

  if (process.platform === 'win32' && processHandle.pid) {
    const result = spawnSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (result.error) throw result.error
  } else {
    child.kill('SIGKILL')
  }
  if (!(await waitForExit(child, 3_000))) {
    throw new Error(`standalone 进程 ${processHandle.pid || 'unknown'} 未在强制停止后退出。`)
  }
}

async function waitForStandalone({ baseUrl, timeoutMs, fetcher, processHandle }) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (processHandle?.child?.exitCode !== null) {
      throw new Error(`production standalone 提前退出，exitCode=${processHandle.child.exitCode}`)
    }
    try {
      const response = await fetcher(`${baseUrl}/api/projects`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`production standalone 启动超时: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function createSparseFile(filePath, sizeBytes) {
  const handle = await fs.open(filePath, 'w')
  try {
    await handle.truncate(sizeBytes)
  } finally {
    await handle.close()
  }
}

async function defaultCreateTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'koubo-standalone-upload-'))
}

async function defaultRemoveTempRoot(tempRoot) {
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function failure(logger, code, error) {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`Production standalone upload smoke failed (${code}): ${message}`)
  return { status: 'failed', error: { code, message } }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await runProductionStandaloneUploadSmoke()
  if (result.status === 'failed') process.exitCode = 1
}
