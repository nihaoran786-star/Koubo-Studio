import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AudioArtifact } from '@/lib/artifacts/audio-artifact'
import type { RenderAvatar, RenderMode } from '@/lib/artifacts/render-artifact'
import type { ScriptArtifact } from '@/lib/artifacts/script-artifact'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import {
  readDevelopmentRuntimeEnv,
  resolveLocalRuntimeConfig,
} from '@/lib/runtime-data/runtime-config-store'
import { inspectManagedRuntime } from '@/lib/managed-runtime/managed-runtime-service'
import { MANAGED_RUNTIME_API_URL, type ManagedRuntimeReport } from '@/lib/managed-runtime/managed-runtime-types'

export interface HeyGemRenderInput {
  scriptArtifactId: string
  audioArtifactId: string
  avatar: RenderAvatar
  mode: RenderMode
}

export interface RunHeyGemAdapterInput {
  projectId: string
  workspacePath: string
  scriptArtifact: ScriptArtifact
  audioArtifact: AudioArtifact
  input: HeyGemRenderInput
  outputPath: string
}

export type RunHeyGemAdapterResult =
  | {
      status: 'ok'
      source: 'heygem'
      outputPath: string
      durationSeconds: number
    }
  | {
      status: 'adapter_error'
      source: 'heygem'
      error: {
        code: string
        message: string
      }
    }

export type RunHeyGemAdapter = (input: RunHeyGemAdapterInput) => Promise<RunHeyGemAdapterResult>

export interface HeyGemRuntimeConfig {
  source: 'managed_wsl' | 'user_config'
  apiUrl?: string
  apiKey?: string
  apiDialect: HeyGemApiDialect
  publicAssetBaseUrl?: string
  resultRoot?: string
  hostDataRoot?: string
  containerDataRoot?: string
  scriptPath?: string
  ffprobePath: string
  timeoutMs: number
  pollIntervalMs: number
}

export interface HeyGemProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface HeyGemProcessRunInput {
  command: string
  args: string[]
  timeoutMs: number
}

export type HeyGemProcessRunner = (input: HeyGemProcessRunInput) => Promise<HeyGemProcessResult>
export type ProbeVideoDuration = (input: { outputPath: string; ffprobePath: string }) => Promise<number>
export type ResolveHeyGemRuntimeConfig = typeof resolveHeyGemRuntimeConfig

const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_RESULT_ERROR_BODY_BYTES = 64 * 1024

type HeyGemApiRenderResult =
  | {
      status: 'ok'
      outputPath: string
    }
  | {
      status: 'adapter_error'
      source: 'heygem'
      error: {
        code: string
        message: string
      }
    }

export type HeyGemApiDialect = 'compatible_render' | 'duix_face2face'

export class HeyGemAdapterError extends Error {
  source = 'heygem' as const

  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HeyGemAdapterError'
  }
}

export function readHeyGemRuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): HeyGemRuntimeConfig | undefined {
  const apiUrl = env.DUIX_AVATAR_API_URL?.trim() || env.HEYGEM_API_URL?.trim()
  const apiKey = env.DUIX_AVATAR_API_KEY?.trim() || env.HEYGEM_API_KEY?.trim()
  const scriptPath = env.DUIX_AVATAR_SCRIPT_PATH?.trim() || env.HEYGEM_SCRIPT_PATH?.trim()
  if (!apiUrl && !scriptPath) return undefined
  return {
    source: 'user_config',
    apiUrl: apiUrl || undefined,
    apiKey: apiKey || undefined,
    apiDialect: readHeyGemApiDialect(env.DUIX_AVATAR_API_DIALECT || env.HEYGEM_API_DIALECT),
    publicAssetBaseUrl: (env.DUIX_AVATAR_PUBLIC_ASSET_BASE_URL?.trim() || env.HEYGEM_PUBLIC_ASSET_BASE_URL?.trim())?.replace(/\/$/, '') || undefined,
    resultRoot: env.DUIX_AVATAR_RESULT_ROOT?.trim() || env.HEYGEM_RESULT_ROOT?.trim() || undefined,
    hostDataRoot: env.DUIX_AVATAR_HOST_DATA_ROOT?.trim() || env.HEYGEM_HOST_DATA_ROOT?.trim() || undefined,
    containerDataRoot: env.DUIX_AVATAR_CONTAINER_DATA_ROOT?.trim() || env.HEYGEM_CONTAINER_DATA_ROOT?.trim() || undefined,
    scriptPath: scriptPath || undefined,
    ffprobePath: env.DUIX_AVATAR_FFPROBE_PATH?.trim() || env.FFPROBE_PATH?.trim() || 'ffprobe',
    timeoutMs: Number(env.DUIX_AVATAR_TIMEOUT_MS || env.HEYGEM_TIMEOUT_MS) > 0
      ? Number(env.DUIX_AVATAR_TIMEOUT_MS || env.HEYGEM_TIMEOUT_MS)
      : 180000,
    pollIntervalMs: Number(env.DUIX_AVATAR_POLL_INTERVAL_MS || env.HEYGEM_POLL_INTERVAL_MS) >= 0
      ? Number(env.DUIX_AVATAR_POLL_INTERVAL_MS || env.HEYGEM_POLL_INTERVAL_MS)
      : 2000,
  }
}

export async function resolveHeyGemRuntimeConfig(options: {
  root?: string
  developmentRoot?: string
  injectedEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>
  isolateInjectedEnv?: boolean
  inspectManaged?: () => Promise<ManagedRuntimeReport>
} = {}): Promise<HeyGemRuntimeConfig | undefined> {
  const isolate = options.isolateInjectedEnv ?? options.injectedEnv !== undefined
  const local = await resolveLocalRuntimeConfig({
    root: options.root,
    developmentRoot: options.developmentRoot,
    injectedEnv: options.injectedEnv,
    isolateInjectedEnv: isolate,
  })
  const developmentEnv = isolate
    ? {}
    : await readDevelopmentRuntimeEnv(options.developmentRoot ?? process.cwd())
  const effectiveEnv = isolate
    ? options.injectedEnv ?? {}
    : { ...developmentEnv, ...process.env, ...options.injectedEnv }
  const apiKey = effectiveEnv.DUIX_AVATAR_API_KEY?.trim() || effectiveEnv.HEYGEM_API_KEY?.trim()
  const config = local.duixAvatar
  if (config.mode === 'managed_wsl') {
    const shouldInspectManaged = options.inspectManaged !== undefined || (!isolate && options.injectedEnv === undefined)
    if (!shouldInspectManaged) return undefined
    const managed = await (options.inspectManaged ?? inspectManagedRuntime)()
    if (managed.status === 'ready') {
      return {
        source: 'managed_wsl',
        apiUrl: MANAGED_RUNTIME_API_URL,
        apiDialect: 'compatible_render',
        ffprobePath: config.ffprobePath,
        timeoutMs: config.timeoutMs,
        pollIntervalMs: config.pollIntervalMs,
      }
    }
    // 默认受管模式不得在未就绪时暗中回退旧 API/脚本配置。
    return undefined
  }
  if (!config.apiUrl && !config.scriptPath) return undefined
  return {
    source: 'user_config',
    apiUrl: config.apiUrl || undefined,
    apiKey: apiKey || undefined,
    apiDialect: config.apiDialect,
    publicAssetBaseUrl: config.publicAssetBaseUrl.replace(/\/$/, '') || undefined,
    resultRoot: config.resultRoot || undefined,
    hostDataRoot: config.hostDataRoot || undefined,
    containerDataRoot: config.containerDataRoot || undefined,
    scriptPath: config.scriptPath || undefined,
    ffprobePath: config.ffprobePath,
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  }
}

function readHeyGemApiDialect(value: string | undefined): HeyGemApiDialect {
  return value?.trim() === 'duix_face2face' ? 'duix_face2face' : 'compatible_render'
}

export function buildHeyGemPowerShellArgs(input: {
  scriptPath: string
  input: RunHeyGemAdapterInput
}) {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    input.scriptPath,
    '-ScriptText',
    input.input.scriptArtifact.content.body,
    '-Audio',
    input.input.audioArtifact.outputPath,
    '-AvatarSource',
    input.input.input.avatar.source,
    '-AvatarId',
    input.input.input.avatar.id,
    '-AvatarAsset',
    input.input.input.avatar.assetPath ?? '',
    '-Mode',
    input.input.input.mode,
    '-Output',
    input.input.outputPath,
  ]
}

export function classifyHeyGemProcessError(result: HeyGemProcessResult) {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.timedOut) {
    return {
      code: 'runtime_timeout',
      message: 'HeyGem 生成超时，请检查后端任务是否卡住或素材是否过大。',
    }
  }
  if (output.includes('not found') || output.includes('runtime') || output.includes('connection refused')) {
    return {
      code: 'runtime_missing',
      message: 'HeyGem runtime/API 不可用，请检查本地服务、脚本路径或端口配置。',
    }
  }
  if (output.includes('avatar')) {
    return {
      code: 'avatar_invalid',
      message: 'HeyGem 无法使用当前数字人形象素材，请检查形象文件或素材格式。',
    }
  }
  return {
    code: 'runtime_failed',
    message: result.stderr.trim() || result.stdout.trim() || `HeyGem 进程退出码：${result.exitCode}`,
  }
}

export async function verifyHeyGemOutput(input: {
  workspacePath: string
  outputPath: string
  ffprobePath?: string
  probeDuration: ProbeVideoDuration
}) {
  const renderRoot = path.join(input.workspacePath, 'artifacts', 'render')
  let outputPath: string
  try {
    outputPath = assertInsideRoot(renderRoot, input.outputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new HeyGemAdapterError('output_path_escape', '输出路径越过了当前 workspace render artifact 目录。')
    }
    throw error
  }

  await assertCanonicalWorkspaceOutput(renderRoot, outputPath)

  try {
    const stat = await fs.stat(outputPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new HeyGemAdapterError('output_missing', 'HeyGem 没有生成有效视频文件。')
    }
  } catch (error) {
    if (error instanceof HeyGemAdapterError) throw error
    throw new HeyGemAdapterError('output_missing', 'HeyGem 没有生成视频文件。')
  }

  const durationSeconds = await input.probeDuration({
    outputPath,
    ffprobePath: input.ffprobePath ?? 'ffprobe',
  })

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new HeyGemAdapterError('invalid_duration', '生成视频时长无效。')
  }

  return {
    outputPath,
    durationSeconds,
  }
}

export const runHeyGemAdapter = async (
  input: RunHeyGemAdapterInput,
  options: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    runtimeConfigRoot?: string
    developmentRoot?: string
    runner?: HeyGemProcessRunner
    fetcher?: typeof fetch
    probeDuration?: ProbeVideoDuration
    maxResultBytes?: number
    resolveRuntimeConfig?: ResolveHeyGemRuntimeConfig
  } = {},
): Promise<RunHeyGemAdapterResult> => {
  let candidateOutputPath: string | undefined
  try {
    await prepareWorkspaceOutputPath(input.workspacePath, input.outputPath)
    candidateOutputPath = createHeyGemCandidatePath(input.outputPath)
    await prepareWorkspaceOutputPath(input.workspacePath, candidateOutputPath)
    const runtimeInput: RunHeyGemAdapterInput = {
      ...input,
      outputPath: candidateOutputPath,
    }
    const config = await (options.resolveRuntimeConfig ?? resolveHeyGemRuntimeConfig)({
      root: options.runtimeConfigRoot,
      developmentRoot: options.developmentRoot,
      injectedEnv: options.env,
      isolateInjectedEnv: options.env !== undefined,
    })
    if (!config) {
      return adapterError('runtime_missing', 'HeyGem 后端尚未配置。请先配置 HEYGEM_API_URL 或 HEYGEM_SCRIPT_PATH。')
    }

    let outputPath = candidateOutputPath

    if (config.apiUrl) {
      const duixAvatarCheck = validateDuixFace2FaceAvatar(config, runtimeInput)
      if (duixAvatarCheck) return duixAvatarCheck

      const apiResult = await callHeyGemApi({
        config,
        input: runtimeInput,
        fetcher: options.fetcher ?? fetch,
        maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      })
      if (apiResult.status !== 'ok') return apiResult
      outputPath = apiResult.outputPath
    } else if (config.scriptPath) {
      await fs.access(config.scriptPath)
      const processResult = await (options.runner ?? runProcess)({
        command: 'powershell',
        args: buildHeyGemPowerShellArgs({
          scriptPath: config.scriptPath,
          input: runtimeInput,
        }),
        timeoutMs: config.timeoutMs,
      })
      if (processResult.exitCode !== 0 || processResult.timedOut) {
        const error = classifyHeyGemProcessError(processResult)
        return adapterError(error.code, error.message)
      }
    }

    const output = await verifyHeyGemOutput({
      workspacePath: input.workspacePath,
      outputPath,
      ffprobePath: config.ffprobePath,
      probeDuration: options.probeDuration ?? probeDurationWithFfprobe,
    })
    await publishVerifiedHeyGemOutput({
      workspacePath: input.workspacePath,
      candidatePath: output.outputPath,
      outputPath: input.outputPath,
    })

    return {
      status: 'ok',
      source: 'heygem',
      outputPath: input.outputPath,
      durationSeconds: output.durationSeconds,
    }
  } catch (error) {
    if (error instanceof HeyGemAdapterError) {
      return adapterError(error.code, error.message)
    }
    if (isMissingPathError(error)) {
      return adapterError('runtime_missing', 'HeyGem 启动脚本或 runtime 路径不存在。')
    }
    const message = error instanceof Error ? error.message : String(error)
    return adapterError('runtime_failed', message)
  } finally {
    if (candidateOutputPath) {
      await fs.rm(candidateOutputPath, { force: true }).catch(() => undefined)
    }
  }
}

function createHeyGemCandidatePath(outputPath: string) {
  const extension = path.extname(outputPath) || '.mp4'
  const basename = path.basename(outputPath, path.extname(outputPath))
  return path.join(
    path.dirname(outputPath),
    `.${basename}.${randomUUID()}.candidate${extension}`,
  )
}

async function publishVerifiedHeyGemOutput(input: {
  workspacePath: string
  candidatePath: string
  outputPath: string
}) {
  await prepareWorkspaceOutputPath(input.workspacePath, input.candidatePath)
  await prepareWorkspaceOutputPath(input.workspacePath, input.outputPath)
  const candidate = await fs.realpath(input.candidatePath)
  if (sameCanonicalPath(candidate, await canonicalPathForComparison(input.outputPath))) return
  const handle = await fs.open(candidate, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(candidate, input.outputPath)
}

function validateDuixFace2FaceAvatar(config: HeyGemRuntimeConfig, input: RunHeyGemAdapterInput) {
  if (config.apiDialect !== 'duix_face2face') return undefined
  const avatar = input.input.avatar
  if (!avatar.assetPath) {
    return adapterError(
      'duix_avatar_video_required',
      'Duix face2face 真实模式必须使用已上传的视频形象素材，不能只传形象库 id。',
    )
  }
  if (isHttpUrl(avatar.assetPath)) {
    return isVideoAssetPath(avatar.assetPath)
      ? undefined
      : adapterError('duix_avatar_video_required', 'Duix face2face 真实模式需要 MP4/MOV/WebM 等视频形象素材 URL。')
  }
  return isVideoAssetPath(avatar.assetPath)
    ? undefined
    : adapterError('duix_avatar_video_required', 'Duix face2face 真实模式需要 MP4/MOV/WebM 等视频形象素材文件。')
}

function isVideoAssetPath(value: string) {
  const pathname = isHttpUrl(value) ? new URL(value).pathname : value
  return ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(path.extname(pathname).toLowerCase())
}

async function callHeyGemApi(input: {
  config: HeyGemRuntimeConfig
  input: RunHeyGemAdapterInput
  fetcher: typeof fetch
  maxResultBytes: number
}): Promise<HeyGemApiRenderResult> {
  if (input.config.apiDialect === 'duix_face2face') {
    return callDuixFace2FaceApi(input)
  }

  return callCompatibleRenderApi(input)
}

async function callCompatibleRenderApi(input: {
  config: HeyGemRuntimeConfig
  input: RunHeyGemAdapterInput
  fetcher: typeof fetch
  maxResultBytes: number
}): Promise<HeyGemApiRenderResult> {
  const managedPaths = input.config.source === 'managed_wsl'
    ? await prepareManagedWslRenderPaths(input.input)
    : undefined
  const response = await input.fetcher(`${input.config.apiUrl?.replace(/\/$/, '')}/render`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(input.config.apiKey ? { authorization: `Bearer ${input.config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      projectId: input.input.projectId,
      scriptText: input.input.scriptArtifact.content.body,
      audioPath: managedPaths?.audioPath ?? input.input.audioArtifact.outputPath,
      avatar: managedPaths?.avatar ?? input.input.input.avatar,
      mode: input.input.input.mode,
      outputPath: managedPaths?.outputPath ?? input.input.outputPath,
      ...(managedPaths ? { pathDialect: 'wsl_mount_v1' } : {}),
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return adapterError('runtime_failed', text || `HeyGem API 返回 HTTP ${response.status}`)
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (payload.status === 'adapter_error' || payload.status === 'failed' || payload.status === 'error') {
    const error = typeof payload.error === 'object' && payload.error !== null ? payload.error as Record<string, unknown> : {}
    return adapterError(
      typeof error.code === 'string' ? error.code : 'runtime_failed',
      typeof error.message === 'string' ? error.message : 'HeyGem API 返回失败状态。',
    )
  }

  const remoteResult =
    readString(payload.resultUrl) ??
    readString(payload.result_url) ??
    readString(payload.videoUrl) ??
    readString(payload.video_url) ??
    readString(payload.url)
  if (remoteResult) {
    if (!isHttpUrl(remoteResult)) {
      return adapterError('result_url_invalid', 'HeyGem resultUrl 只允许使用 HTTP(S) 地址。')
    }
    return downloadRemoteResultToWorkspace({
      resultUrl: remoteResult,
      outputPath: input.input.outputPath,
      fetcher: input.fetcher,
      sourceLabel: 'HeyGem compatible',
      maxBytes: input.maxResultBytes,
    })
  }

  if (managedPaths) {
    const managedOutputPath = payload.outputPath
    if (typeof managedOutputPath !== 'string' || managedOutputPath.length === 0) {
      return adapterError('output_missing', 'KouboRuntime API 没有返回本次请求的候选 outputPath。')
    }
    if (managedOutputPath !== managedPaths.outputPath) {
      return adapterError(
        'managed_output_path_mismatch',
        'KouboRuntime 返回的 outputPath 与本次请求的候选路径不一致。',
      )
    }
    return { status: 'ok', outputPath: input.input.outputPath }
  }
  const localResult = readString(payload.outputPath)
  if (!localResult) {
    return adapterError('output_missing', 'HeyGem API 没有返回可读取的结果 URL 或路径。')
  }
  return copyLocalResultToWorkspace({
    resultPath: localResult,
    resultRoot: input.config.resultRoot,
    outputPath: input.input.outputPath,
    sourceLabel: 'HeyGem compatible',
  })
}

interface ManagedWslRenderPaths {
  audioPath: string
  avatar: RenderAvatar
  outputPath: string
}

async function prepareManagedWslRenderPaths(
  input: RunHeyGemAdapterInput,
): Promise<ManagedWslRenderPaths> {
  const canonicalWorkspace = await canonicalManagedInputPath(input.workspacePath, 'workspace')
  const canonicalAudio = await canonicalManagedInputPath(input.audioArtifact.outputPath, 'audio')
  assertManagedPathInsideWorkspace(canonicalWorkspace, canonicalAudio, 'audio')

  const avatar = input.input.avatar
  let managedAvatar = avatar
  if (avatar.source === 'upload') {
    if (!avatar.assetPath) {
      throw new HeyGemAdapterError(
        'managed_avatar_path_required',
        'KouboRuntime 使用上传形象时必须提供 workspace 内的形象素材路径。',
      )
    }
    const canonicalAvatar = await canonicalManagedInputPath(avatar.assetPath, 'avatar')
    assertManagedPathInsideWorkspace(canonicalWorkspace, canonicalAvatar, 'avatar')
    managedAvatar = {
      ...avatar,
      assetPath: windowsPathToWslMountPath(canonicalAvatar),
    }
  }

  assertManagedWindowsPath(input.outputPath, 'output')
  const canonicalOutputParent = await canonicalManagedInputPath(path.dirname(input.outputPath), 'output')
  assertManagedPathInsideWorkspace(canonicalWorkspace, canonicalOutputParent, 'output')
  const canonicalOutput = path.win32.join(canonicalOutputParent, path.win32.basename(input.outputPath))

  return {
    audioPath: windowsPathToWslMountPath(canonicalAudio),
    avatar: managedAvatar,
    outputPath: windowsPathToWslMountPath(canonicalOutput),
  }
}

async function canonicalManagedInputPath(filePath: string, field: string) {
  assertManagedWindowsPath(filePath, field)
  try {
    return await fs.realpath(filePath)
  } catch (error) {
    throw new HeyGemAdapterError(
      'managed_input_path_invalid',
      `KouboRuntime ${field} 路径不存在或无法解析：${readNodeErrorCode(error) ?? 'unknown'}`,
    )
  }
}

function assertManagedPathInsideWorkspace(workspacePath: string, filePath: string, field: string) {
  const relative = path.win32.relative(workspacePath, filePath)
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.win32.sep}`) && relative !== '..' && !path.win32.isAbsolute(relative))
  ) {
    return
  }
  throw new HeyGemAdapterError(
    'managed_input_path_escape',
    `KouboRuntime ${field} 路径越过了当前 workspace。`,
  )
}

function assertManagedWindowsPath(value: string, field: string) {
  try {
    windowsPathToWslMountPath(value)
  } catch {
    throw new HeyGemAdapterError(
      'managed_input_path_invalid',
      `KouboRuntime ${field} 只接受不含设备前缀、UNC、ADS 或 NUL 的 Windows 盘符绝对路径。`,
    )
  }
}

export function windowsPathToWslMountPath(value: string) {
  if (
    value.includes('\0') ||
    /^\\\\[?.]\\/.test(value) ||
    /^\\\\/.test(value) ||
    !/^[a-z]:[\\/]/i.test(value) ||
    value.slice(2).includes(':')
  ) {
    throw new Error('invalid_windows_drive_path')
  }
  const normalized = path.win32.normalize(value)
  if (!/^[a-z]:\\/i.test(normalized)) {
    throw new Error('invalid_windows_drive_path')
  }
  const drive = normalized[0].toLowerCase()
  const segments = normalized
    .slice(3)
    .split('\\')
    .filter(Boolean)
  return `/mnt/${drive}${segments.length > 0 ? `/${segments.join('/')}` : ''}`
}

async function callDuixFace2FaceApi(input: {
  config: HeyGemRuntimeConfig
  input: RunHeyGemAdapterInput
  fetcher: typeof fetch
  maxResultBytes: number
}): Promise<HeyGemApiRenderResult> {
  const baseUrl = input.config.apiUrl?.replace(/\/$/, '')
  const code = `${input.input.projectId}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  const audioUrl = resolveDuixAudioUrl(input.config, input.input)
  const avatarVideoUrl = resolveDuixAvatarVideoUrl(input.config, input.input)
  const submitResponse = await input.fetcher(`${baseUrl}/easy/submit`, {
    method: 'POST',
    headers: buildHeyGemApiHeaders(input.config),
    body: JSON.stringify({
      audio_url: audioUrl,
      video_url: avatarVideoUrl,
      code,
      chaofen: input.input.input.mode === 'cinema' ? 1 : 0,
      watermark_switch: 0,
      pn: 1,
    }),
  })

  if (!submitResponse.ok) {
    const text = await submitResponse.text().catch(() => '')
    return adapterError('task_submit_failed', text || `HeyGem submit API 返回 HTTP ${submitResponse.status}`)
  }
  const submitPayload = await submitResponse.json().catch(() => ({})) as Record<string, unknown>
  const submitError = readDuixError(submitPayload)
  if (submitError) return submitError

  const deadline = Date.now() + input.config.timeoutMs
  while (Date.now() <= deadline) {
    const queryResponse = await input.fetcher(`${baseUrl}/easy/query?code=${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: buildHeyGemApiHeaders(input.config),
    })
    if (!queryResponse.ok) {
      const text = await queryResponse.text().catch(() => '')
      return adapterError('task_query_failed', text || `HeyGem query API 返回 HTTP ${queryResponse.status}`)
    }

    const payload = await queryResponse.json().catch(() => ({})) as Record<string, unknown>
    const error = readDuixError(payload)
    if (error) return error

    const data = readRecord(payload.data)
    const status = readDuixStatus(data?.status) ?? readDuixStatus(payload.status)
    const progress = readDuixProgress(data?.progress) ?? readDuixProgress(payload.progress)
    // Official Duix can expose progress=100 while status=1 and its GPU/ffmpeg
    // workers are still rendering. Only use progress as a completion signal
    // for compatible responses that omit status entirely.
    const completed = status === '2' || status === 'success' || status === 'done' || (!status && progress >= 100)
    if (completed) {
      const resultPath = readString(data?.result) ?? readString(data?.result_url) ?? readString(data?.video_url) ?? readString(data?.url) ?? readString(payload.result) ?? readString(payload.result_url)
      if (!resultPath) return adapterError('output_missing', 'HeyGem query API 已完成但没有返回结果路径。')
      return copyDuixResultToWorkspace({
        resultPath,
        resultRoot: input.config.resultRoot,
        outputPath: input.input.outputPath,
        fetcher: input.fetcher,
        maxResultBytes: input.maxResultBytes,
      })
    }
    if (status === '3' || status === 'failed' || status === 'error') {
      const message = readString(data?.msg) ?? readString(data?.message) ?? 'HeyGem face2face 任务失败。'
      return adapterError('task_failed', message)
    }

    await delay(input.config.pollIntervalMs)
  }

  return adapterError('task_timeout', 'HeyGem face2face 任务轮询超时。')
}

function resolveDuixAudioUrl(config: HeyGemRuntimeConfig, input: RunHeyGemAdapterInput) {
  const containerPath = mapHostPathToContainer(input.audioArtifact.outputPath, config)
  if (containerPath) return containerPath
  if (!config.publicAssetBaseUrl) return input.audioArtifact.outputPath
  return buildProjectApiFileUrl(config.publicAssetBaseUrl, input.projectId, [
    'audio-artifacts',
    input.audioArtifact.artifactId,
    'file',
  ])
}

function resolveDuixAvatarVideoUrl(config: HeyGemRuntimeConfig, input: RunHeyGemAdapterInput) {
  const avatar = input.input.avatar
  if (avatar.assetPath?.startsWith('http://') || avatar.assetPath?.startsWith('https://')) {
    return avatar.assetPath
  }
  if (avatar.assetPath) {
    const containerPath = mapHostPathToContainer(avatar.assetPath, config)
    if (containerPath) return containerPath
  }
  if (config.publicAssetBaseUrl && avatar.source === 'upload') {
    return buildProjectApiFileUrl(config.publicAssetBaseUrl, input.projectId, [
      'avatar-assets',
      avatar.id,
      'file',
    ])
  }
  return avatar.assetPath || avatar.id
}

function buildProjectApiFileUrl(baseUrl: string, projectId: string, segments: string[]) {
  const encoded = [
    'api',
    'projects',
    projectId,
    ...segments,
  ].map((segment) => encodeURIComponent(segment))
  return `${baseUrl.replace(/\/$/, '')}/${encoded.join('/')}`
}

function buildHeyGemApiHeaders(config: HeyGemRuntimeConfig) {
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  }
}

async function copyDuixResultToWorkspace(input: {
  resultPath: string
  resultRoot?: string
  outputPath: string
  fetcher: typeof fetch
  maxResultBytes: number
}): Promise<HeyGemApiRenderResult> {
  if (isHttpUrl(input.resultPath)) {
    return downloadRemoteResultToWorkspace({
      resultUrl: input.resultPath,
      outputPath: input.outputPath,
      fetcher: input.fetcher,
      sourceLabel: 'Duix-Avatar',
      maxBytes: input.maxResultBytes,
    })
  }
  if (hasUriScheme(input.resultPath)) {
    return adapterError('result_url_invalid', 'Duix-Avatar 结果 URL 只允许使用 HTTP(S) 地址。')
  }
  return copyLocalResultToWorkspace({
    resultPath: input.resultPath,
    resultRoot: input.resultRoot,
    outputPath: input.outputPath,
    sourceLabel: 'Duix-Avatar',
  })
}

async function copyLocalResultToWorkspace(input: {
  resultPath: string
  resultRoot?: string
  outputPath: string
  sourceLabel: string
}): Promise<HeyGemApiRenderResult> {
  if (!input.resultRoot) {
    return adapterError(
      'result_root_required',
      `${input.sourceLabel} 返回了本机结果路径，但当前未配置可信 resultRoot；远程服务必须返回 HTTP(S) resultUrl。`,
    )
  }
  const lexicalSource = path.isAbsolute(input.resultPath)
    ? resolveDuixHostResultPath(input.resultPath, input.resultRoot)
    : path.resolve(input.resultRoot, input.resultPath)
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
  await copyDuixResultWithRetry(lexicalSource, input.outputPath, input.resultRoot)
  return { status: 'ok', outputPath: input.outputPath }
}

async function copyDuixResultWithRetry(sourcePath: string, outputPath: string, resultRoot: string) {
  // Duix lite reports progress=100 before its ffmpeg worker releases the
  // bind-mounted MP4 on Windows. Keep the task running while that handle is
  // released instead of turning a successful render into a false failure.
  const attempts = 120
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let tempPath: string | undefined
    try {
      const canonicalRoot = await fs.realpath(resultRoot)
      const canonicalSource = await fs.realpath(sourcePath)
      assertCanonicalInsideRoot(canonicalRoot, canonicalSource)
      if (!sameCanonicalPath(canonicalSource, await canonicalPathForComparison(outputPath))) {
        tempPath = path.join(
          path.dirname(outputPath),
          `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
        )
        await fs.copyFile(canonicalSource, tempPath, fsConstants.COPYFILE_EXCL)
        const handle = await fs.open(tempPath, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await fs.rename(tempPath, outputPath)
        tempPath = undefined
      }
      return
    } catch (error) {
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined)
      if (error instanceof HeyGemAdapterError) throw error
      const code = readNodeErrorCode(error)
      const retryable = code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM'
      if (!retryable || attempt === attempts) {
        if (retryable) {
          throw new HeyGemAdapterError(
            'output_missing',
            'Duix-Avatar 已报告完成，但视频文件尚未出现在宿主机目录。请确认 resultRoot 与 Docker 数据目录映射。',
          )
        }
        throw error
      }
      await delay(250)
    }
  }
}

function readNodeErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return String(error.code)
}

function mapHostPathToContainer(filePath: string, config: HeyGemRuntimeConfig) {
  if (!config.hostDataRoot || !config.containerDataRoot) return undefined
  const relative = path.relative(config.hostDataRoot, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return `${config.containerDataRoot.replace(/\/$/, '')}/${relative.split(path.sep).join('/')}`
}

function resolveDuixHostResultPath(resultPath: string, resultRoot?: string) {
  if (!resultRoot) return resultPath
  if (/^[a-z]:[\\/]/i.test(resultPath) || /^\\\\/.test(resultPath)) {
    return path.resolve(resultPath)
  }
  const normalized = resultPath.replace(/\\/g, '/')
  const relative = normalized.replace(/^\/+/, '')
  return path.resolve(resultRoot, relative)
}

async function downloadRemoteResultToWorkspace(input: {
  resultUrl: string
  outputPath: string
  fetcher: typeof fetch
  sourceLabel: string
  maxBytes: number
}): Promise<HeyGemApiRenderResult> {
  if (!isHttpUrl(input.resultUrl)) {
    return adapterError('result_url_invalid', `${input.sourceLabel} result URL 只允许使用 HTTP(S) 地址。`)
  }
  const response = await input.fetcher(input.resultUrl, {
    method: 'GET',
  })
  if (!response.ok) {
    const text = await readBoundedResponseText(response, MAX_RESULT_ERROR_BODY_BYTES).catch(() => '')
    return adapterError('result_download_failed', text || `${input.sourceLabel} result URL 返回 HTTP ${response.status}`)
  }
  const contentLength = readContentLength(response.headers.get('content-length'))
  if (contentLength !== undefined && contentLength > input.maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return adapterError('result_too_large', `${input.sourceLabel} 返回的视频超过允许的最大大小。`)
  }
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
  const tempPath = path.join(path.dirname(input.outputPath), `.${path.basename(input.outputPath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    if (!response.body) {
      return adapterError('result_download_empty', `${input.sourceLabel} result URL 没有返回视频内容。`)
    }
    handle = await fs.open(tempPath, 'wx')
    const reader = response.body.getReader()
    let received = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      received += value.byteLength
      if (received > input.maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new HeyGemAdapterError('result_too_large', `${input.sourceLabel} 返回的视频超过允许的最大大小。`)
      }
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
        if (bytesWritten <= 0) throw new Error('写入 HeyGem 下载临时文件时没有取得进展。')
        offset += bytesWritten
      }
    }
    if (received <= 0) {
      throw new HeyGemAdapterError('result_download_empty', `${input.sourceLabel} result URL 返回了空视频文件。`)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, input.outputPath)
    return { status: 'ok', outputPath: input.outputPath }
  } catch (error) {
    if (error instanceof HeyGemAdapterError) return adapterError(error.code, error.message)
    return adapterError(
      'result_download_failed',
      error instanceof Error ? error.message : `${input.sourceLabel} 视频下载中断。`,
    )
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      const remaining = maxBytes - received
      if (remaining <= 0) {
        await reader.cancel().catch(() => undefined)
        return `${text}\n[错误响应已截断]`
      }
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      text += decoder.decode(chunk, { stream: true })
      received += chunk.byteLength
      if (chunk.byteLength < value.byteLength) {
        await reader.cancel().catch(() => undefined)
        return `${text}${decoder.decode()}\n[错误响应已截断]`
      }
    }
    return `${text}${decoder.decode()}`
  } finally {
    reader.releaseLock()
  }
}

function readContentLength(value: string | null) {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function assertCanonicalInsideRoot(canonicalRoot: string, canonicalSource: string) {
  const relative = path.relative(canonicalRoot, canonicalSource)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return
  throw new HeyGemAdapterError('result_path_escape', '运行时返回的结果路径越过了配置的 resultRoot。')
}

async function prepareWorkspaceOutputPath(workspacePath: string, outputPath: string) {
  const renderRoot = path.join(workspacePath, 'artifacts', 'render')
  let safeOutput: string
  try {
    safeOutput = assertInsideRoot(renderRoot, outputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new HeyGemAdapterError('output_path_escape', '输出路径越过了当前 workspace render artifact 目录。')
    }
    throw error
  }
  await fs.mkdir(renderRoot, { recursive: true })
  await fs.mkdir(path.dirname(safeOutput), { recursive: true })
  await assertCanonicalWorkspaceOutput(renderRoot, safeOutput)
}

async function assertCanonicalWorkspaceOutput(renderRoot: string, outputPath: string) {
  const canonicalRoot = await fs.realpath(renderRoot)
  const canonicalParent = await fs.realpath(path.dirname(outputPath))
  try {
    assertCanonicalInsideRoot(canonicalRoot, canonicalParent)
  } catch (error) {
    if (error instanceof HeyGemAdapterError) {
      throw new HeyGemAdapterError('output_path_escape', '输出路径通过链接越过了当前 workspace render artifact 目录。')
    }
    throw error
  }
  try {
    const stat = await fs.lstat(outputPath)
    if (stat.isSymbolicLink()) {
      throw new HeyGemAdapterError('output_path_escape', '输出文件不能是符号链接。')
    }
  } catch (error) {
    if (error instanceof HeyGemAdapterError) throw error
    if (readNodeErrorCode(error) !== 'ENOENT') throw error
  }
}

async function canonicalPathForComparison(filePath: string) {
  try {
    return await fs.realpath(filePath)
  } catch (error) {
    if (readNodeErrorCode(error) === 'ENOENT') return path.resolve(filePath)
    throw error
  }
}

function sameCanonicalPath(left: string, right: string) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function hasUriScheme(value: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value)
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function readDuixError(payload: Record<string, unknown>) {
  const code = readDuixStatus(payload.code)
  if (code && code !== '10000' && code !== '0') {
    return adapterError('runtime_failed', readString(payload.msg) ?? readString(payload.message) ?? `HeyGem API 返回错误码：${code}`)
  }
  return undefined
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readDuixStatus(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return readString(value)?.toLowerCase()
}

function readDuixProgress(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value.trim())
    return Number.isFinite(parsed) ? parsed : -1
  }
  return -1
}

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runProcess(input: HeyGemProcessRunInput): Promise<HeyGemProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, input.timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
      })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

async function probeDurationWithFfprobe(input: { outputPath: string; ffprobePath: string }) {
  const result = await runProcess({
    command: input.ffprobePath,
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input.outputPath],
    timeoutMs: 30000,
  })

  if (result.exitCode !== 0 || result.timedOut) {
    throw new HeyGemAdapterError('duration_probe_failed', result.stderr || 'ffprobe 读取视频时长失败。')
  }

  return Number.parseFloat(result.stdout.trim())
}

function adapterError(code: string, message: string): Extract<RunHeyGemAdapterResult, { status: 'adapter_error' }> {
  return {
    status: 'adapter_error',
    source: 'heygem',
    error: {
      code,
      message,
    },
  }
}

function isMissingPathError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
