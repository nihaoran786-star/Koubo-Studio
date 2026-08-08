import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getRuntimeSettingsRoot } from './runtime-data-root'

const CONFIG_FILE = 'runtime-config.json'
const INDEXTTS2_KEYS = ['runtimeRoot', 'scriptPath', 'ffmpegPath', 'ffprobePath', 'timeoutMs'] as const
const DUIX_AVATAR_KEYS = [
  'mode',
  'apiUrl', 'apiDialect', 'publicAssetBaseUrl', 'resultRoot', 'hostDataRoot',
  'containerDataRoot', 'scriptPath', 'ffprobePath', 'timeoutMs', 'pollIntervalMs',
] as const

export interface LocalIndexTTS2RuntimeConfig {
  runtimeRoot: string
  scriptPath: string
  ffmpegPath: string
  ffprobePath: string
  timeoutMs: number
}

export interface LocalDuixAvatarRuntimeConfig {
  mode: 'managed_wsl' | 'custom'
  apiUrl: string
  apiDialect: 'compatible_render' | 'duix_face2face'
  publicAssetBaseUrl: string
  resultRoot: string
  hostDataRoot: string
  containerDataRoot: string
  scriptPath: string
  ffprobePath: string
  timeoutMs: number
  pollIntervalMs: number
}

export interface LocalRuntimeConfig {
  indextts2: LocalIndexTTS2RuntimeConfig
  duixAvatar: LocalDuixAvatarRuntimeConfig
}

export type LocalRuntimeConfigPatch = {
  indextts2?: Partial<LocalIndexTTS2RuntimeConfig>
  duixAvatar?: Partial<LocalDuixAvatarRuntimeConfig>
}

export interface ResolveLocalRuntimeConfigOptions {
  root?: string
  developmentRoot?: string
  injectedEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>
  isolateInjectedEnv?: boolean
}

export class RuntimeConfigStoreError extends Error {
  constructor(
    public code: 'invalid_runtime_config' | 'runtime_config_read_failed' | 'runtime_config_write_failed',
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeConfigStoreError'
  }
}

export function createDefaultLocalRuntimeConfig(): LocalRuntimeConfig {
  return {
    indextts2: {
      runtimeRoot: '',
      scriptPath: path.resolve(
        /* turbopackIgnore: true */ process.cwd(),
        '..',
        'skills',
        'natural-tts-voice-cloning',
        'scripts',
        'Invoke-NaturalTTS.ps1',
      ),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      timeoutMs: 180000,
    },
    duixAvatar: {
      mode: 'managed_wsl',
      apiUrl: '',
      apiDialect: 'compatible_render',
      publicAssetBaseUrl: '',
      resultRoot: '',
      hostDataRoot: '',
      containerDataRoot: '',
      scriptPath: '',
      ffprobePath: 'ffprobe',
      timeoutMs: 180000,
      pollIntervalMs: 2000,
    },
  }
}

export async function readLocalRuntimeConfig(
  options: { root?: string } = {},
): Promise<LocalRuntimeConfig> {
  try {
    const raw = await fs.readFile(configPath(options.root), 'utf8')
    return parseStoredConfig(JSON.parse(raw) as unknown)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return createDefaultLocalRuntimeConfig()
    if (error instanceof RuntimeConfigStoreError) throw error
    throw new RuntimeConfigStoreError('runtime_config_read_failed', '本地运行配置无法读取或解析。')
  }
}

export async function writeLocalRuntimeConfig(
  config: LocalRuntimeConfig,
  options: { root?: string } = {},
): Promise<LocalRuntimeConfig> {
  const normalized = validateLocalRuntimeConfig(config)
  const filePath = configPath(options.root)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await fs.rename(tempPath, filePath)
    return normalized
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    if (error instanceof RuntimeConfigStoreError) throw error
    throw new RuntimeConfigStoreError('runtime_config_write_failed', '本地运行配置无法保存。')
  }
}

export async function updateLocalRuntimeConfig(
  patch: LocalRuntimeConfigPatch,
  options: { root?: string } = {},
) {
  validatePatchShape(patch)
  const current = await readLocalRuntimeConfig(options)
  return writeLocalRuntimeConfig({
    ...current,
    indextts2: {
      ...current.indextts2,
      ...patch.indextts2,
    },
    duixAvatar: {
      ...current.duixAvatar,
      ...patch.duixAvatar,
      mode: patch.duixAvatar?.mode
        ?? (patch.duixAvatar && hasCustomDuixRuntime(patch.duixAvatar) ? 'custom' : current.duixAvatar.mode),
    },
  }, options)
}

export async function resolveLocalRuntimeConfig(
  options: ResolveLocalRuntimeConfigOptions = {},
): Promise<LocalRuntimeConfig> {
  if (options.isolateInjectedEnv) {
    return applyEnvironment(createDefaultLocalRuntimeConfig(), options.injectedEnv ?? {})
  }

  const persisted = await readLocalRuntimeConfig({ root: options.root })
  // Development env files are opt-in here. Production routes must never scan
  // process.cwd(): in a Next standalone build that makes the file tracer treat
  // the entire repository (including local .env files and media) as runtime
  // input. Dev/smoke entrypoints already load these files into process.env.
  const developmentEnv = options.developmentRoot
    ? await readDevelopmentRuntimeEnv(options.developmentRoot)
    : {}
  return applyEnvironment(
    applyEnvironment(
      applyEnvironment(persisted, developmentEnv),
      process.env,
    ),
    options.injectedEnv ?? {},
  )
}

export function localRuntimeConfigToEnv(config: LocalRuntimeConfig): Record<string, string> {
  return {
    INDEXTTS2_RUNTIME_ROOT: config.indextts2.runtimeRoot,
    INDEXTTS2_SCRIPT_PATH: config.indextts2.scriptPath,
    FFMPEG_PATH: config.indextts2.ffmpegPath,
    FFPROBE_PATH: config.indextts2.ffprobePath,
    INDEXTTS2_TIMEOUT_MS: String(config.indextts2.timeoutMs),
    DUIX_AVATAR_API_URL: config.duixAvatar.apiUrl,
    DUIX_AVATAR_MODE: config.duixAvatar.mode,
    DUIX_AVATAR_API_DIALECT: config.duixAvatar.apiDialect,
    DUIX_AVATAR_PUBLIC_ASSET_BASE_URL: config.duixAvatar.publicAssetBaseUrl,
    DUIX_AVATAR_RESULT_ROOT: config.duixAvatar.resultRoot,
    DUIX_AVATAR_HOST_DATA_ROOT: config.duixAvatar.hostDataRoot,
    DUIX_AVATAR_CONTAINER_DATA_ROOT: config.duixAvatar.containerDataRoot,
    DUIX_AVATAR_SCRIPT_PATH: config.duixAvatar.scriptPath,
    DUIX_AVATAR_FFPROBE_PATH: config.duixAvatar.ffprobePath,
    DUIX_AVATAR_TIMEOUT_MS: String(config.duixAvatar.timeoutMs),
    DUIX_AVATAR_POLL_INTERVAL_MS: String(config.duixAvatar.pollIntervalMs),
  }
}

export async function readDevelopmentRuntimeEnv(root: string) {
  const result: Record<string, string> = {}
  for (const name of ['.env.runtime.local', '.env.local']) {
    try {
      // 仅在开发/测试时读取调用方明确传入的根目录；不要让 Turbopack 把动态路径扩展为整个项目。
      const content = await fs.readFile(path.join(/* turbopackIgnore: true */ root, name), 'utf8')
      for (const rawLine of content.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(rawLine)
        if (!match) continue
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        result[match[1]] = value
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
  }
  return result
}

export function validateLocalRuntimeConfig(value: unknown): LocalRuntimeConfig {
  if (!isPlainObject(value)) invalid('本地运行配置必须是对象。')
  assertOnlyKeys(value, ['indextts2', 'duixAvatar'], '本地运行配置')
  if (!isPlainObject(value.indextts2)) invalid('indextts2 配置必须是对象。')
  assertOnlyKeys(value.indextts2, INDEXTTS2_KEYS, 'indextts2 配置')

  const runtimeRoot = requireString(value.indextts2.runtimeRoot, 'runtimeRoot', true)
  const scriptPath = requireString(value.indextts2.scriptPath, 'scriptPath')
  const ffmpegPath = requireString(value.indextts2.ffmpegPath, 'ffmpegPath')
  const ffprobePath = requireString(value.indextts2.ffprobePath, 'ffprobePath')
  const timeoutMs = requireTimeout(value.indextts2.timeoutMs)
  const defaults = createDefaultLocalRuntimeConfig()
  const duixSource = value.duixAvatar === undefined ? defaults.duixAvatar : value.duixAvatar
  if (!isPlainObject(duixSource)) invalid('duixAvatar 配置必须是对象。')
  assertOnlyKeys(duixSource, DUIX_AVATAR_KEYS, 'duixAvatar 配置')
  const duixAvatar = validateDuixAvatarConfig({
    ...defaults.duixAvatar,
    ...duixSource,
    // 旧持久化配置有明确外部端点或脚本时，迁移为 custom，不能被新默认模式接管。
    mode: typeof duixSource.mode === 'string'
      ? duixSource.mode
      : hasCustomDuixRuntime(duixSource) ? 'custom' : 'managed_wsl',
  })
  return { indextts2: { runtimeRoot, scriptPath, ffmpegPath, ffprobePath, timeoutMs }, duixAvatar }
}

export function validateLocalRuntimeConfigPatch(value: unknown): LocalRuntimeConfigPatch {
  if (!isPlainObject(value)) invalid('本地运行配置必须是对象。')
  validatePatchShape(value)
  const patch: LocalRuntimeConfigPatch = {}
  if (value.indextts2 !== undefined) {
    const source = value.indextts2 as Record<string, unknown>
    const indextts2: Partial<LocalIndexTTS2RuntimeConfig> = {}
    if ('runtimeRoot' in source) indextts2.runtimeRoot = requireString(source.runtimeRoot, 'runtimeRoot', true)
    if ('scriptPath' in source) indextts2.scriptPath = requireString(source.scriptPath, 'scriptPath')
    if ('ffmpegPath' in source) indextts2.ffmpegPath = requireString(source.ffmpegPath, 'ffmpegPath')
    if ('ffprobePath' in source) indextts2.ffprobePath = requireString(source.ffprobePath, 'ffprobePath')
    if ('timeoutMs' in source) indextts2.timeoutMs = requireTimeout(source.timeoutMs)
    patch.indextts2 = indextts2
  }
  if (value.duixAvatar !== undefined) {
    const source = value.duixAvatar as Record<string, unknown>
    const duixAvatar: Partial<LocalDuixAvatarRuntimeConfig> = {}
    if ('mode' in source) duixAvatar.mode = requireDuixMode(source.mode)
    if ('apiUrl' in source) duixAvatar.apiUrl = requireString(source.apiUrl, 'apiUrl', true)
    if ('apiDialect' in source) duixAvatar.apiDialect = requireDialect(source.apiDialect)
    if ('publicAssetBaseUrl' in source) duixAvatar.publicAssetBaseUrl = requireString(source.publicAssetBaseUrl, 'publicAssetBaseUrl', true)
    if ('resultRoot' in source) duixAvatar.resultRoot = requireString(source.resultRoot, 'resultRoot', true)
    if ('hostDataRoot' in source) duixAvatar.hostDataRoot = requireString(source.hostDataRoot, 'hostDataRoot', true)
    if ('containerDataRoot' in source) duixAvatar.containerDataRoot = requireString(source.containerDataRoot, 'containerDataRoot', true)
    if ('scriptPath' in source) duixAvatar.scriptPath = requireString(source.scriptPath, 'scriptPath', true)
    if ('ffprobePath' in source) duixAvatar.ffprobePath = requireString(source.ffprobePath, 'ffprobePath')
    if ('timeoutMs' in source) duixAvatar.timeoutMs = requireTimeout(source.timeoutMs)
    if ('pollIntervalMs' in source) duixAvatar.pollIntervalMs = requirePollInterval(source.pollIntervalMs)
    patch.duixAvatar = duixAvatar
  }
  return patch
}

function parseStoredConfig(value: unknown) {
  return validateLocalRuntimeConfig(value)
}

function validatePatchShape(value: unknown): asserts value is LocalRuntimeConfigPatch {
  if (!isPlainObject(value)) invalid('本地运行配置必须是对象。')
  assertOnlyKeys(value, ['indextts2', 'duixAvatar'], '本地运行配置')
  if (value.indextts2 !== undefined) {
    if (!isPlainObject(value.indextts2)) invalid('indextts2 配置必须是对象。')
    assertOnlyKeys(value.indextts2, INDEXTTS2_KEYS, 'indextts2 配置')
  }
  if (value.duixAvatar !== undefined) {
    if (!isPlainObject(value.duixAvatar)) invalid('duixAvatar 配置必须是对象。')
    assertOnlyKeys(value.duixAvatar, DUIX_AVATAR_KEYS, 'duixAvatar 配置')
  }
}

function applyEnvironment(
  base: LocalRuntimeConfig,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): LocalRuntimeConfig {
  const next = {
    ...base.indextts2,
    runtimeRoot: env.INDEXTTS2_RUNTIME_ROOT?.trim() || base.indextts2.runtimeRoot,
    scriptPath: env.INDEXTTS2_SCRIPT_PATH?.trim() || base.indextts2.scriptPath,
    ffmpegPath: env.FFMPEG_PATH?.trim() || base.indextts2.ffmpegPath,
    ffprobePath: env.FFPROBE_PATH?.trim() || base.indextts2.ffprobePath,
  }
  const timeout = Number(env.INDEXTTS2_TIMEOUT_MS)
  if (Number.isInteger(timeout) && timeout >= 1000 && timeout <= 3600000) next.timeoutMs = timeout
  const duix = {
    ...base.duixAvatar,
    apiUrl: firstEnv(env, 'DUIX_AVATAR_API_URL', 'HEYGEM_API_URL') || base.duixAvatar.apiUrl,
    apiDialect: readDialect(firstEnv(env, 'DUIX_AVATAR_API_DIALECT', 'HEYGEM_API_DIALECT'), base.duixAvatar.apiDialect),
    publicAssetBaseUrl: firstEnv(env, 'DUIX_AVATAR_PUBLIC_ASSET_BASE_URL', 'HEYGEM_PUBLIC_ASSET_BASE_URL') || base.duixAvatar.publicAssetBaseUrl,
    resultRoot: firstEnv(env, 'DUIX_AVATAR_RESULT_ROOT', 'HEYGEM_RESULT_ROOT') || base.duixAvatar.resultRoot,
    hostDataRoot: firstEnv(env, 'DUIX_AVATAR_HOST_DATA_ROOT', 'HEYGEM_HOST_DATA_ROOT') || base.duixAvatar.hostDataRoot,
    containerDataRoot: firstEnv(env, 'DUIX_AVATAR_CONTAINER_DATA_ROOT', 'HEYGEM_CONTAINER_DATA_ROOT') || base.duixAvatar.containerDataRoot,
    scriptPath: firstEnv(env, 'DUIX_AVATAR_SCRIPT_PATH', 'HEYGEM_SCRIPT_PATH') || base.duixAvatar.scriptPath,
    ffprobePath: firstEnv(env, 'DUIX_AVATAR_FFPROBE_PATH', 'FFPROBE_PATH') || base.duixAvatar.ffprobePath,
  }
  // 环境变量提供端点或脚本表示操作者明确选择外部 runtime；不得继续走 managed 默认。
  if (hasCustomDuixRuntime(env)) duix.mode = 'custom'
  const duixTimeout = Number(firstEnv(env, 'DUIX_AVATAR_TIMEOUT_MS', 'HEYGEM_TIMEOUT_MS'))
  if (Number.isInteger(duixTimeout) && duixTimeout >= 1000 && duixTimeout <= 3600000) duix.timeoutMs = duixTimeout
  const pollInterval = Number(firstEnv(env, 'DUIX_AVATAR_POLL_INTERVAL_MS', 'HEYGEM_POLL_INTERVAL_MS'))
  if (Number.isInteger(pollInterval) && pollInterval >= 0 && pollInterval <= 60000) duix.pollIntervalMs = pollInterval
  return { indextts2: next, duixAvatar: duix }
}

function validateDuixAvatarConfig(value: Record<string, unknown>): LocalDuixAvatarRuntimeConfig {
  return {
    mode: requireDuixMode(value.mode),
    apiUrl: requireString(value.apiUrl, 'apiUrl', true),
    apiDialect: requireDialect(value.apiDialect),
    publicAssetBaseUrl: requireString(value.publicAssetBaseUrl, 'publicAssetBaseUrl', true),
    resultRoot: requireString(value.resultRoot, 'resultRoot', true),
    hostDataRoot: requireString(value.hostDataRoot, 'hostDataRoot', true),
    containerDataRoot: requireString(value.containerDataRoot, 'containerDataRoot', true),
    scriptPath: requireString(value.scriptPath, 'scriptPath', true),
    ffprobePath: requireString(value.ffprobePath, 'ffprobePath'),
    timeoutMs: requireTimeout(value.timeoutMs),
    pollIntervalMs: requirePollInterval(value.pollIntervalMs),
  }
}

function requireDuixMode(value: unknown): LocalDuixAvatarRuntimeConfig['mode'] {
  if (value !== 'managed_wsl' && value !== 'custom') invalid('数字人运行模式无效。')
  return value
}

function hasCustomDuixRuntime(value: Record<string, unknown>) {
  return Boolean(
    firstValue(value, 'apiUrl', 'DUIX_AVATAR_API_URL', 'HEYGEM_API_URL') ||
    firstValue(value, 'scriptPath', 'DUIX_AVATAR_SCRIPT_PATH', 'HEYGEM_SCRIPT_PATH'),
  )
}

function firstValue(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const current = value[key]
    if (typeof current === 'string' && current.trim()) return current
  }
  return ''
}

function firstEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>, ...keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return ''
}

function readDialect(value: string, fallback: LocalDuixAvatarRuntimeConfig['apiDialect']) {
  return value === 'duix_face2face' || value === 'compatible_render' ? value : fallback
}

function requireDialect(value: unknown): LocalDuixAvatarRuntimeConfig['apiDialect'] {
  if (value !== 'compatible_render' && value !== 'duix_face2face') invalid('apiDialect 无效。')
  return value
}

function requirePollInterval(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 60000) {
    invalid('pollIntervalMs 必须是 0 至 60000 之间的整数。')
  }
  return Number(value)
}

function requireString(value: unknown, key: string, allowEmpty = false) {
  if (typeof value !== 'string') invalid(`${key} 必须是字符串。`)
  const normalized = value.trim()
  if (!allowEmpty && !normalized) invalid(`${key} 不能为空。`)
  if (normalized.length > 4096) invalid(`${key} 过长。`)
  return normalized
}

function requireTimeout(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1000 || Number(value) > 3600000) {
    invalid('timeoutMs 必须是 1000 至 3600000 之间的整数。')
  }
  return Number(value)
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length > 0) invalid(`${label}包含未知字段：${unknown.join(', ')}。`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function invalid(message: string): never {
  throw new RuntimeConfigStoreError('invalid_runtime_config', message)
}

function configPath(root = getRuntimeSettingsRoot()) {
  return path.join(root, CONFIG_FILE)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
