import fs from 'node:fs'
import path from 'node:path'
import type {
  RuntimeReadinessCheck,
  RuntimeReadinessProfile,
  RuntimeReadinessProfileId,
  RuntimeReadinessResult,
} from './runtime-readiness-types'
import type { ManagedRuntimeStatus } from '@/lib/managed-runtime/managed-runtime-types'

const PROFILES: Record<RuntimeReadinessProfileId, RuntimeReadinessProfile> = {
  base: {
    id: 'base',
    title: '基础版',
    description: '只要求文案、workspace 和基础应用可用；重模型可按需连接。',
    requiredCheckIds: ['model_provider'],
  },
  local_enhanced: {
    id: 'local_enhanced',
    title: '本地增强版',
    description: '要求声音、数字人和本地 ffmpeg 剪辑 runtime 可用。',
    requiredCheckIds: ['model_provider', 'indextts2', 'heygem', 'post_production'],
  },
  publish_enhanced: {
    id: 'publish_enhanced',
    title: '发布增强版',
    description: '要求本地成片可用；发布包面向抖音和小红书，可见浏览器由用户监督。',
    requiredCheckIds: ['model_provider', 'post_production', 'browser_publish'],
  },
  remote_runtime: {
    id: 'remote_runtime',
    title: '远程 runtime',
    description: '声音和数字人 runtime 可使用已配置的远程 HTTP endpoint。',
    requiredCheckIds: ['model_provider', 'indextts2', 'heygem'],
  },
  full: {
    id: 'full',
    title: '完整验收',
    description: '检查文案、声音、数字人、剪辑、发布准备和桌面承载。',
    requiredCheckIds: ['model_provider', 'indextts2', 'heygem', 'post_production', 'browser_publish', 'desktop_release'],
  },
}

type RuntimeEnv = Record<string, string | undefined>
export type ModelProviderReadinessState = 'connected' | 'unverified' | 'unreachable' | 'needs_setup'

export function detectRuntimeReadiness({
  env = process.env,
  providerState = 'needs_setup',
  managedRuntimeStatus,
  commandExists = defaultCommandExists,
  endpointReachable = () => false,
}: {
  env?: RuntimeEnv
  providerState?: ModelProviderReadinessState
  managedRuntimeStatus?: ManagedRuntimeStatus
  commandExists?: (command: string) => boolean
  endpointReachable?: (url: string) => boolean
} = {}): RuntimeReadinessResult {
  const profile = PROFILES[readProfileId(env)]
  const checks = [
    checkModelProvider(providerState),
    checkIndexTts(env, endpointReachable),
    checkHeyGem(env, endpointReachable, managedRuntimeStatus),
    checkPostProduction(env, commandExists),
    checkBrowserPublish(),
    checkDesktopRelease(env),
  ].map((check) => applyProfile(check, profile))
  const summary = checks.reduce((result, check) => {
    result[check.status] += 1
    return result
  }, { ready: 0, missing: 0, warning: 0 })
  return {
    status: checks.some((check) => check.status === 'missing') ? 'missing' : 'ready',
    source: 'runtime_readiness',
    profile,
    updatedAt: new Date().toISOString(),
    summary,
    checks,
  }
}

function checkModelProvider(settingsState: ModelProviderReadinessState) {
  if (settingsState === 'unverified') {
    return createCheck({
      id: 'model_provider',
      title: 'AI 文案 Provider',
      ready: false,
      gap: '默认 AI Provider 尚未验证连接。',
      nextStep: '打开设置，测试默认 Provider 连接。',
      envKeys: [],
      envTemplate: '# 请在设置页测试默认 Provider',
      command: '打开设置并测试连接',
      required: ['已验证的默认 AI Provider'],
      sensitiveEnvKeys: [],
    })
  }
  if (settingsState === 'unreachable') {
    return createCheck({
      id: 'model_provider',
      title: 'AI 文案 Provider',
      ready: false,
      gap: '默认 AI Provider 当前不可达。',
      nextStep: '打开设置，检查服务或网络后重新测试连接。',
      envKeys: [],
      envTemplate: '# 请在设置页重新测试默认 Provider',
      command: '打开设置并重新测试连接',
      required: ['可连接的默认 AI Provider'],
      sensitiveEnvKeys: [],
    })
  }
  if (settingsState === 'needs_setup') {
    return createCheck({
      id: 'model_provider',
      title: 'AI 文案 Provider',
      ready: false,
      gap: '默认 AI Provider 尚未完成配置。',
      nextStep: '打开设置，启用并配置默认 Provider。',
      envKeys: [],
      envTemplate: '# 请在设置页配置默认 Provider',
      command: '打开设置并配置 Provider',
      required: ['已启用且凭据完整的默认 AI Provider'],
      sensitiveEnvKeys: [],
    })
  }
  return createCheck({
    id: 'model_provider',
    title: 'AI 文案 Provider',
    ready: settingsState === 'connected',
    gap: '尚未配置可用的 AI Provider。',
    nextStep: '在设置页配置本地或云端 AI Provider。',
    envKeys: [],
    envTemplate: '# 请在设置页配置并测试默认 Provider',
    command: '打开设置并测试连接',
    required: ['本地或云端 AI Provider'],
    sensitiveEnvKeys: ['OPENAI_API_KEY'],
  })
}

function checkIndexTts(env: RuntimeEnv, endpointReachable: (url: string) => boolean) {
  const apiUrl = env.INDEXTTS2_API_URL?.trim()
  const runtimeRoot = env.INDEXTTS2_RUNTIME_ROOT?.trim()
  const scriptPath = env.INDEXTTS2_SCRIPT_PATH?.trim()
  const indexRoot = runtimeRoot ? path.join(runtimeRoot, 'IndexTTS') : undefined
  const localReady = Boolean(
    indexRoot &&
    hasFile(path.join(indexRoot, '.venv', 'Scripts', 'python.exe')) &&
    hasFile(path.join(indexRoot, 'checkpoints', 'config.yaml')) &&
    hasFile(scriptPath),
  )
  const ready = localReady || Boolean(apiUrl && isHttpUrl(apiUrl) && endpointReachable(apiUrl))
  return createCheck({
    id: 'indextts2', title: 'IndexTTS2 声音', ready,
    gap: '尚未连接 IndexTTS2 runtime。', nextStep: '配置本机 Python/脚本或远程 HTTP endpoint。',
    envKeys: ['INDEXTTS2_API_URL', 'INDEXTTS2_PYTHON_PATH'], envTemplate: 'INDEXTTS2_API_URL=\nINDEXTTS2_PYTHON_PATH=',
    command: 'pnpm smoke:indextts2', required: ['IndexTTS2 runtime'], sensitiveEnvKeys: [],
  })
}

function checkHeyGem(
  env: RuntimeEnv,
  endpointReachable: (url: string) => boolean,
  managedRuntimeStatus: ManagedRuntimeStatus | undefined,
) {
  const apiUrl = env.DUIX_AVATAR_API_URL?.trim() || env.HEYGEM_API_URL?.trim()
  const scriptPath = env.DUIX_AVATAR_SCRIPT_PATH?.trim() || env.HEYGEM_SCRIPT_PATH?.trim()
  const mode = env.DUIX_AVATAR_MODE?.trim() === 'custom' || Boolean(apiUrl || scriptPath) ? 'custom' : 'managed_wsl'
  const apiConfigured = Boolean(apiUrl && isHttpUrl(apiUrl))
  const ready = mode === 'managed_wsl'
    ? managedRuntimeStatus === 'ready'
    : hasFile(scriptPath) || Boolean(apiConfigured && endpointReachable(apiUrl!))
  return createCheck({
    id: 'heygem', title: 'Duix / HeyGem 数字人', ready,
    gap: mode === 'managed_wsl'
      ? 'KouboRuntime WSL 尚未就绪。'
      : apiConfigured ? 'Duix/HeyGem API 协议探测失败。' : '尚未连接数字人 runtime。',
    nextStep: mode === 'managed_wsl'
      ? '在设置中导入并启动 KouboRuntime WSL（无需 Docker）。'
      : '启动 Duix/HeyGem 服务并确认健康接口返回有效 JSON，或配置可用的本机脚本。',
    envKeys: mode === 'managed_wsl' ? [] : ['DUIX_AVATAR_API_URL', 'HEYGEM_API_URL', 'HEYGEM_SCRIPT_PATH'],
    envTemplate: mode === 'managed_wsl' ? '# 设置页导入并启动 KouboRuntime WSL' : 'DUIX_AVATAR_API_URL=http://127.0.0.1:8383\nHEYGEM_SCRIPT_PATH=',
    command: 'pnpm smoke:heygem-runtime', required: [mode === 'managed_wsl' ? 'KouboRuntime WSL（免 Docker）' : 'Duix/HeyGem runtime'], sensitiveEnvKeys: ['HEYGEM_API_KEY'],
  })
}

function checkPostProduction(env: RuntimeEnv, commandExists: (command: string) => boolean) {
  const ready = env.RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE === '1' || commandExists(env.FFMPEG_PATH?.trim() || 'ffmpeg')
  return createCheck({
    id: 'post_production', title: '本地剪辑', ready,
    gap: 'ffmpeg 尚不可用。', nextStep: '安装 ffmpeg，或在设置中配置可执行文件路径。',
    envKeys: ['FFMPEG_PATH', 'FFPROBE_PATH'], envTemplate: 'FFMPEG_PATH=ffmpeg\nFFPROBE_PATH=ffprobe',
    command: 'pnpm smoke:post-production-local-skill', required: ['ffmpeg', 'ffprobe'], sensitiveEnvKeys: [],
  })
}

function checkBrowserPublish(): RuntimeReadinessCheck {
  return {
    id: 'browser_publish',
    title: '可见浏览器发布',
    status: 'warning',
    requiredForCurrentProfile: false,
    optionalForCurrentProfile: true,
    gaps: ['本地发布包可用；浏览器自动填写将在用户监督登录后接入。'],
    nextStep: '先准备抖音或小红书发布包，浏览器流程必须停在最终提交前。',
    provisioning: {
      priority: 5,
      stage: '用户监督接入',
      required: ['本机可见浏览器', '用户登录与最终确认'],
      sensitiveEnvKeys: [],
      safeEvidence: '只记录本地发布包和非敏感运行状态，不保存密码、cookie 或验证码。',
    },
    remediation: {
      envKeys: [],
      envTemplate: '# 无需旧发布后端配置',
      command: 'pnpm test -- lib/publish',
      docPath: 'docs/CONTEXT.md#浏览器发布',
    },
  }
}

function checkDesktopRelease(env: RuntimeEnv) {
  return createCheck({
    id: 'desktop_release', title: 'Windows 桌面承载', ready: env.RUN_DESKTOP_RELEASE_SMOKE === '1',
    gap: '尚未执行桌面 release smoke。', nextStep: '构建桌面包并执行 release smoke。',
    envKeys: ['RUN_DESKTOP_RELEASE_SMOKE'], envTemplate: 'RUN_DESKTOP_RELEASE_SMOKE=1',
    command: 'pnpm smoke:desktop-release', required: ['Tauri release 包'], sensitiveEnvKeys: [],
  })
}

function createCheck(input: {
  id: string
  title: string
  ready: boolean
  gap: string
  nextStep: string
  envKeys: string[]
  envTemplate: string
  command: string
  required: string[]
  sensitiveEnvKeys: string[]
}): RuntimeReadinessCheck {
  return {
    id: input.id,
    title: input.title,
    status: input.ready ? 'ready' : 'missing',
    requiredForCurrentProfile: false,
    optionalForCurrentProfile: true,
    gaps: input.ready ? [] : [input.gap],
    nextStep: input.ready ? '已就绪。' : input.nextStep,
    provisioning: {
      priority: 1,
      stage: 'runtime 配置',
      required: input.required,
      sensitiveEnvKeys: input.sensitiveEnvKeys,
      safeEvidence: '仅记录配置项名称和非敏感状态。',
    },
    remediation: {
      envKeys: input.envKeys,
      envTemplate: input.envTemplate,
      command: input.command,
      docPath: 'docs/CONTEXT.md#runtime-关键规则',
    },
  }
}

function applyProfile(check: RuntimeReadinessCheck, profile: RuntimeReadinessProfile): RuntimeReadinessCheck {
  const required = profile.requiredCheckIds.includes(check.id)
  return {
    ...check,
    status: !required && check.status === 'missing' ? 'warning' : check.status,
    requiredForCurrentProfile: required,
    optionalForCurrentProfile: !required,
  }
}

function readProfileId(env: RuntimeEnv): RuntimeReadinessProfileId {
  const value = env.KOUBO_RUNTIME_PROFILE ?? env.RUNTIME_PROFILE
  return value && value in PROFILES ? value as RuntimeReadinessProfileId : 'base'
}

function isHttpUrl(value: string | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value.trim()))
}

function hasFile(value: string | undefined) {
  if (!value?.trim()) return false
  try {
    return fs.statSync(value.trim()).isFile()
  } catch {
    return false
  }
}

function defaultCommandExists(command: string) {
  if (command.includes('/') || command.includes('\\')) return hasFile(command)
  return false
}
