import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  resolveDefaultModelProvider,
  type ModelProviderResolutionResult,
} from '@/lib/model-providers/model-provider-resolution'
import {
  ModelChatError,
  requestOpenAICompatibleChat,
  type ModelChatUsage,
} from '@/lib/model-providers/openai-compatible-chat-adapter'
import { EditPlanValidationError, parseEditPlan, type EditPlanV1 } from './edit-plan'
import type { EditMediaAssetKind } from './edit-media-asset'
import {
  isRemotionEffectId,
  REMOTION_EFFECT_IDS,
  type RemotionEffectId,
} from './remotion-effect-registry'

export interface AvailableEditAsset {
  assetId: string
  kind: EditMediaAssetKind
}

export interface AiEditPlanUsage {
  source: 'model' | 'cache'
  inputCharacters: number
  estimatedInputTokens: number
  maxOutputTokens: number
  cacheKey: string
  reportedInputTokens?: number
  reportedOutputTokens?: number
  reportedTotalTokens?: number
}

export type GenerateAiEditPlanResult =
  | {
      status: 'ok'
      source: 'ai_edit_plan_agent' | 'ai_edit_plan_cache'
      plan: EditPlanV1
      usage?: AiEditPlanUsage
    }
  | {
      status: 'needs_configuration' | 'agent_error'
      source: 'ai_edit_plan_agent'
      error: { code: string; message: string }
    }

interface CompactEditDecisionV1 {
  v: 1
  r: '9:16' | '1:1' | '16:9'
  f: 'cover' | 'contain'
  s: 'clean' | 'bold' | 'cyan'
  c: number
  vv: number
  bg: string | null
  bv: number
  i: string | null
  o: string | null
  ct: number
  p: 'preserve' | 'tight'
  ep: 'clean' | 'energetic' | 'cinematic'
  mo: 'none' | 'punch' | 'dynamic'
  cp: 'static' | 'karaoke' | 'impact'
  cg: 'natural' | 'vivid' | 'warm'
  fx: 'off' | 'subtle' | 'punch'
  hk: string | null
  kw: string[]
  ef: RemotionEffectId[]
}

const MAX_INSTRUCTION_CHARS = 400
const MAX_SCRIPT_CHARS = 1800
const MAX_ASSETS = 48
const MAX_OUTPUT_TOKENS = 700

export async function generateAiEditPlan(input: {
  instruction: string
  script: string
  currentPlan: EditPlanV1
  availableAssets: AvailableEditAsset[]
  videoDurationSeconds?: number
  cacheDirectory?: string
  resolveProvider?: () => Promise<ModelProviderResolutionResult>
  requestChat?: typeof requestOpenAICompatibleChat
}): Promise<GenerateAiEditPlanResult> {
  const providerResult = await (input.resolveProvider ?? resolveDefaultModelProvider)()
  if (providerResult.status !== 'ok') {
    return failure('needs_configuration', `ai_provider_${providerResult.error.code}`, providerResult.error.message)
  }

  const context = buildCompactPlanningContext(input)
  const user = JSON.stringify(context)
  const cacheKey = createHash('sha256')
    .update(JSON.stringify({
      schema: 3,
      providerId: providerResult.provider.providerId,
      modelId: providerResult.provider.modelId,
      context,
    }))
    .digest('hex')
  const generationOptions = lowTokenGenerationOptions(
    providerResult.provider.providerKind,
    providerResult.provider.modelId,
  )
  const usageBase = {
    inputCharacters: EDIT_PLAN_SYSTEM_PROMPT.length + user.length,
    estimatedInputTokens: estimateTokens(EDIT_PLAN_SYSTEM_PROMPT + user),
    maxOutputTokens:
      generationOptions.maxOutputTokens ??
      generationOptions.maxCompletionTokens ??
      MAX_OUTPUT_TOKENS,
    cacheKey,
  }

  if (input.cacheDirectory) {
    const cached = await readCachedPlan(input.cacheDirectory, cacheKey)
    if (cached) {
      return {
        status: 'ok',
        source: 'ai_edit_plan_cache',
        plan: cached,
        usage: { source: 'cache', ...usageBase },
      }
    }
  }

  try {
    let reportedUsage: ModelChatUsage | undefined
    const reply = await (input.requestChat ?? requestOpenAICompatibleChat)({
      provider: providerResult.provider,
      system: EDIT_PLAN_SYSTEM_PROMPT,
      user,
      ...generationOptions,
      onUsage: (usage) => {
        reportedUsage = usage
      },
    })
    const decision = parseCompactDecision(parseModelJson(reply), input.availableAssets, input.script)
    const plan = mergeDecision(input.currentPlan, decision, input.videoDurationSeconds)
    if (input.cacheDirectory) await writeCachedPlan(input.cacheDirectory, cacheKey, plan)
    return {
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan,
      usage: {
        source: 'model',
        ...usageBase,
        ...(reportedUsage?.inputTokens === undefined
          ? {}
          : { reportedInputTokens: reportedUsage.inputTokens }),
        ...(reportedUsage?.outputTokens === undefined
          ? {}
          : { reportedOutputTokens: reportedUsage.outputTokens }),
        ...(reportedUsage?.totalTokens === undefined
          ? {}
          : { reportedTotalTokens: reportedUsage.totalTokens }),
      },
    }
  } catch (error) {
    if (error instanceof ModelChatError) {
      const needsConfiguration = error.code === 'auth_error' || error.code === 'model_error'
      return failure(
        needsConfiguration ? 'needs_configuration' : 'agent_error',
        `ai_model_${error.code}`,
        error.message,
      )
    }
    if (error instanceof AiEditPlanError || error instanceof EditPlanValidationError) {
      return failure('agent_error', error.code, error.message)
    }
    return failure('agent_error', 'ai_edit_plan_error', 'AI 剪辑计划生成失败，请重试。')
  }
}

function lowTokenGenerationOptions(providerKind: string, modelId: string) {
  const normalizedModel = modelId.trim().toLowerCase()
  if (normalizedModel === 'deepseek-v4-flash') {
    return {
      maxOutputTokens: 1_400,
      thinkingMode: 'disabled' as const,
    }
  }
  if (/^gemini-3(?:\.|[-_])/.test(normalizedModel)) {
    return {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: 'low' as const,
    }
  }
  if (
    providerKind === 'openai' &&
    (/^gpt-5(?:\.|[-_])/.test(normalizedModel) || /^o[1-9](?:[-_]|$)/.test(normalizedModel))
  ) {
    return {
      maxCompletionTokens: MAX_OUTPUT_TOKENS,
      reasoningEffort: 'minimal' as const,
    }
  }
  return {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.1,
  }
}

export function buildCompactPlanningContext(input: {
  instruction: string
  script: string
  currentPlan: EditPlanV1
  availableAssets: AvailableEditAsset[]
  videoDurationSeconds?: number
}) {
  return {
    i: compactText(input.instruction, MAX_INSTRUCTION_CHARS),
    t: compactText(input.script, MAX_SCRIPT_CHARS),
    n: normalizeWhitespace(input.script).length,
    d: round(input.videoDurationSeconds ?? 0, 2),
    p: {
      r: input.currentPlan.ratio,
      f: input.currentPlan.framing.mode,
      s: input.currentPlan.subtitles.style,
      c: input.currentPlan.subtitles.maxCharsPerCue,
      vv: input.currentPlan.audio.voiceVolume,
      bg: input.currentPlan.backgroundMusic.assetId ?? null,
      bv: input.currentPlan.backgroundMusic.volume,
      i: input.currentPlan.intro.assetId ?? null,
        o: input.currentPlan.outro.assetId ?? null,
        ct: input.currentPlan.cover.timestampSeconds,
        pace: input.currentPlan.timeline.removeSilence ? 'tight' : 'preserve',
        ep: input.currentPlan.creative.preset,
        mo: input.currentPlan.creative.motion,
        cp: input.currentPlan.creative.captions,
        cg: input.currentPlan.creative.colorGrade,
        fx: input.currentPlan.creative.soundEffects,
        ef: input.currentPlan.creative.effects,
      },
    a: input.availableAssets.slice(0, MAX_ASSETS).map(({ assetId, kind }) => [
      kind === 'background_music' ? 'b' : kind === 'intro' ? 'i' : 'o',
      assetId,
    ]),
    e: REMOTION_EFFECT_IDS,
  }
}

const EDIT_PLAN_SYSTEM_PROMPT = `你是短视频口播精剪导演。输入是压缩后的文案和本地事实，不包含视频帧。目标是让成片有明显但不过度的视觉节奏，而不只是基础字幕。
只返回一行 JSON，必须且只能有这些短字段：
{"v":1,"r":"9:16|1:1|16:9","f":"cover|contain","s":"clean|bold|cyan","c":6到40整数,"vv":0到2,"bg":"背景音乐素材ID或null","bv":0到1,"i":"片头素材ID或null","o":"片尾素材ID或null","ct":封面秒数,"p":"preserve|tight","ep":"clean|energetic|cinematic","mo":"none|punch|dynamic","cp":"static|karaoke|impact","cg":"natural|vivid|warm","fx":"off|subtle|punch","hk":"24字以内开场钩子或null","kw":["文案中原样出现的重点词，最多8项，每项12字内"],"ef":["只能从e选择的Remotion动效ID，最多5项"]}
默认短视频使用 energetic+punch+impact+vivid+subtle；严肃或克制主题可用 clean+karaoke+natural。hk 必须短、具体、有吸引力但不能捏造事实。kw 必须从 t 原文复制，优先数字、结论、转折和情绪词。
只能使用 a 中提供的对应类型素材 ID 和 e 中提供的动效 ID。没有合适素材就返回 null。用户明确要求紧凑、去停顿或快节奏时 p 才用 tight，否则 preserve。不得返回解释、Markdown、路径、命令或额外字段。`

const DECISION_KEYS = [
  'v', 'r', 'f', 's', 'c', 'vv', 'bg', 'bv', 'i', 'o', 'ct', 'p',
  'ep', 'mo', 'cp', 'cg', 'fx', 'hk', 'kw', 'ef',
]
const FORBIDDEN_KEYS = new Set(['command', 'path', 'args', 'skill', 'executor'])

class AiEditPlanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'AiEditPlanError'
  }
}

function parseModelJson(reply: string): unknown {
  try {
    return JSON.parse(reply)
  } catch {
    throw new AiEditPlanError('invalid_ai_edit_plan_json', 'AI 返回的剪辑计划不是完整 JSON，请重试。')
  }
}

function parseCompactDecision(value: unknown, assets: AvailableEditAsset[], script: string): CompactEditDecisionV1 {
  scanForbiddenKeys(value)
  assertExactObject(value, DECISION_KEYS)
  const decision = value as Record<string, unknown>
  if (decision.v !== 1) invalid('invalid_ai_edit_plan_version', 'AI 剪辑决策版本无效。')
  if (decision.r !== '9:16' && decision.r !== '1:1' && decision.r !== '16:9') {
    invalid('invalid_ratio', 'AI 返回的画面比例无效。')
  }
  if (decision.f !== 'cover' && decision.f !== 'contain') {
    invalid('invalid_framing_mode', 'AI 返回的画面构图无效。')
  }
  if (decision.s !== 'clean' && decision.s !== 'bold' && decision.s !== 'cyan') {
    invalid('invalid_subtitle_style', 'AI 返回的字幕样式无效。')
  }
  const bg = assetOrNull(decision.bg, 'background_music', assets)
  const intro = assetOrNull(decision.i, 'intro', assets)
  const outro = assetOrNull(decision.o, 'outro', assets)
  if (decision.p !== 'preserve' && decision.p !== 'tight') {
    invalid('invalid_edit_pace', 'AI 返回的剪辑节奏无效。')
  }
  if (decision.ep !== 'clean' && decision.ep !== 'energetic' && decision.ep !== 'cinematic') {
    invalid('invalid_creative_preset', 'AI 返回的创意风格无效。')
  }
  if (decision.mo !== 'none' && decision.mo !== 'punch' && decision.mo !== 'dynamic') {
    invalid('invalid_creative_motion', 'AI 返回的镜头运动无效。')
  }
  if (decision.cp !== 'static' && decision.cp !== 'karaoke' && decision.cp !== 'impact') {
    invalid('invalid_creative_captions', 'AI 返回的动态字幕无效。')
  }
  if (decision.cg !== 'natural' && decision.cg !== 'vivid' && decision.cg !== 'warm') {
    invalid('invalid_color_grade', 'AI 返回的色彩风格无效。')
  }
  if (decision.fx !== 'off' && decision.fx !== 'subtle' && decision.fx !== 'punch') {
    invalid('invalid_sound_effects', 'AI 返回的音效风格无效。')
  }
  const hook = decision.hk === null
    ? null
    : displayText(decision.hk, 24, 'invalid_creative_hook')
  if (!Array.isArray(decision.kw) || decision.kw.length > 8) {
    invalid('invalid_creative_emphasis', 'AI 返回的重点词数组无效。')
  }
  const normalizedScript = normalizeWhitespace(script)
  const keywords = decision.kw
    .map((value) => displayText(value, 12, 'invalid_creative_emphasis'))
    .filter((keyword) => normalizedScript.includes(keyword))
  if (
    !Array.isArray(decision.ef) ||
    decision.ef.length > 5 ||
    !decision.ef.every(isRemotionEffectId)
  ) {
    invalid('invalid_creative_effects', 'AI 返回了注册表之外的 Remotion 动效。')
  }
  return {
    v: 1,
    r: decision.r,
    f: decision.f,
    s: decision.s,
    c: boundedNumber(decision.c, 6, 40, 'invalid_subtitle_length'),
    vv: boundedNumber(decision.vv, 0, 2, 'invalid_voice_volume'),
    bg,
    bv: boundedNumber(decision.bv, 0, 1, 'invalid_background_music_volume'),
    i: intro,
    o: outro,
    ct: boundedNumber(decision.ct, 0, 86400, 'invalid_cover_timestamp'),
    p: decision.p,
    ep: decision.ep,
    mo: decision.mo,
    cp: decision.cp,
    cg: decision.cg,
    fx: decision.fx,
    hk: hook,
    kw: keywords,
    ef: [...new Set(decision.ef)],
  }
}

function mergeDecision(
  currentPlan: EditPlanV1,
  decision: CompactEditDecisionV1,
  durationSeconds?: number,
) {
  return parseEditPlan({
    ...currentPlan,
    ratio: decision.r,
    framing: { mode: decision.f },
    timeline: {
      ...currentPlan.timeline,
      removeSilence: decision.p === 'tight',
    },
    subtitles: {
      ...currentPlan.subtitles,
      enabled: true,
      style: decision.s,
      maxCharsPerCue: Math.round(decision.c),
    },
    creative: {
      preset: decision.ep,
      motion: decision.mo,
      captions: decision.cp,
      colorGrade: decision.cg,
      soundEffects: decision.fx,
      ...(decision.hk ? { hook: decision.hk } : {}),
      emphasis: decision.kw,
      effects: normalizeEffectSelection(decision),
    },
    audio: { voiceVolume: decision.vv },
    backgroundMusic: {
      enabled: decision.bg !== null,
      ...(decision.bg ? { assetId: decision.bg } : {}),
      volume: decision.bv,
    },
    intro: { enabled: decision.i !== null, ...(decision.i ? { assetId: decision.i } : {}) },
    outro: { enabled: decision.o !== null, ...(decision.o ? { assetId: decision.o } : {}) },
    cover: {
      timestampSeconds: durationSeconds && durationSeconds > 0
        ? Math.min(decision.ct, Math.max(0, durationSeconds - 0.05))
        : decision.ct,
    },
  })
}

function normalizeEffectSelection(decision: CompactEditDecisionV1): RemotionEffectId[] {
  const effects = new Set<RemotionEffectId>(decision.ef)
  if (decision.cp !== 'static') effects.add('animated-captions')
  if (decision.hk) effects.add('hook-card')
  if (decision.mo !== 'none') effects.add('punch-zoom')
  if (decision.ep === 'energetic') {
    effects.add('progress-line')
    effects.add('light-leak')
  }
  if (decision.ep === 'cinematic') {
    effects.add('focus-glow')
    effects.add('light-leak')
  }
  return [...effects].slice(0, 5)
}

function displayText(value: unknown, maxLength: number, code: string) {
  if (typeof value !== 'string') invalid(code, 'AI 返回了无效的展示文本。')
  const normalized = normalizeWhitespace(value)
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalid(code, 'AI 返回了无效的展示文本。')
  }
  return normalized
}

function assetOrNull(
  value: unknown,
  expectedKind: EditMediaAssetKind,
  assets: AvailableEditAsset[],
) {
  if (value === null) return null
  if (typeof value !== 'string') invalid('invalid_ai_asset', 'AI 返回的素材 ID 无效。')
  const match = assets.find((asset) => asset.assetId === value)
  if (!match || match.kind !== expectedKind) {
    invalid('unknown_ai_asset', 'AI 返回了未提供或类型不匹配的素材 ID。')
  }
  return value
}

function scanForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(scanForbiddenKeys)
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new AiEditPlanError('forbidden_ai_edit_plan_field', `AI 剪辑计划包含禁止字段：${key}。`)
    }
    scanForbiddenKeys(nested)
  }
}

function assertExactObject(value: unknown, allowedKeys: string[]) {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new AiEditPlanError('invalid_ai_edit_plan_shape', 'AI 剪辑计划结构无效。')
  }
  const keys = Object.keys(value)
  const unknownKey = keys.find((key) => !allowedKeys.includes(key))
  if (unknownKey) {
    throw new AiEditPlanError('unknown_ai_edit_plan_field', `AI 剪辑计划包含未知字段：${unknownKey}。`)
  }
  const missingKey = allowedKeys.find((key) => !keys.includes(key))
  if (missingKey) {
    throw new AiEditPlanError('missing_ai_edit_plan_field', `AI 剪辑计划缺少字段：${missingKey}。`)
  }
}

function boundedNumber(value: unknown, min: number, max: number, code: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(code, 'AI 返回了超出范围的剪辑参数。')
  }
  return value
}

function compactText(value: string, maxChars: number) {
  const normalized = normalizeWhitespace(value)
  if (normalized.length <= maxChars) return normalized
  const headLength = Math.ceil(maxChars * 0.65)
  const tailLength = maxChars - headLength - 1
  return `${normalized.slice(0, headLength)}…${normalized.slice(-tailLength)}`
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function estimateTokens(value: string) {
  let weightedCharacters = 0
  for (const character of value) {
    weightedCharacters += /[\u3400-\u9fff]/u.test(character) ? 1.2 : 0.32
  }
  return Math.max(1, Math.ceil(weightedCharacters))
}

function round(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

async function readCachedPlan(directory: string, cacheKey: string) {
  try {
    const raw = await fs.readFile(path.join(directory, `${cacheKey}.json`), 'utf8')
    const value = JSON.parse(raw) as { version?: unknown; plan?: unknown }
    if (value.version !== 1) return undefined
    return parseEditPlan(value.plan)
  } catch {
    return undefined
  }
}

async function writeCachedPlan(directory: string, cacheKey: string, plan: EditPlanV1) {
  await fs.mkdir(directory, { recursive: true })
  const finalPath = path.join(directory, `${cacheKey}.json`)
  const candidate = path.join(directory, `.${cacheKey}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(candidate, JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      plan,
    }), 'utf8')
    await fs.rename(candidate, finalPath)
  } finally {
    await fs.rm(candidate, { force: true }).catch(() => undefined)
  }
}

function failure(
  status: 'needs_configuration' | 'agent_error',
  code: string,
  message: string,
): GenerateAiEditPlanResult {
  return { status, source: 'ai_edit_plan_agent', error: { code, message } }
}

function invalid(code: string, message: string): never {
  throw new AiEditPlanError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
