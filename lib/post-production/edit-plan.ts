import type { PostProductionRatio, PostProductionSubtitleStyle } from '@/lib/artifacts/post-production-artifact'
import { isRemotionEffectId, type RemotionEffectId } from './remotion-effect-registry'

export interface EditPlanV1 {
  version: 1
  ratio: PostProductionRatio
  framing: {
    mode: 'cover' | 'contain'
  }
  timeline: {
    removeSilence: boolean
    silenceThresholdDb: number
    minSilenceMs: number
    keepPaddingMs: number
  }
  subtitles: {
    enabled: boolean
    style: PostProductionSubtitleStyle
    maxCharsPerCue: number
  }
  creative: {
    preset: 'clean' | 'energetic' | 'cinematic'
    motion: 'none' | 'punch' | 'dynamic'
    captions: 'static' | 'karaoke' | 'impact'
    colorGrade: 'natural' | 'vivid' | 'warm'
    soundEffects: 'off' | 'subtle' | 'punch'
    hook?: string
    emphasis: string[]
    effects: RemotionEffectId[]
  }
  audio: {
    voiceVolume: number
  }
  backgroundMusic: {
    enabled: boolean
    assetId?: string
    volume: number
  }
  intro: {
    enabled: boolean
    assetId?: string
  }
  outro: {
    enabled: boolean
    assetId?: string
  }
  cover: {
    timestampSeconds: number
  }
  export: {
    format: 'mp4'
    videoCodec: 'h264'
  }
}

export class EditPlanValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'EditPlanValidationError'
  }
}

export function createDefaultEditPlan(input: {
  ratio?: PostProductionRatio
  subtitleStyle?: PostProductionSubtitleStyle
} = {}): EditPlanV1 {
  return {
    version: 1,
    ratio: input.ratio ?? '9:16',
    framing: {
      mode: 'cover',
    },
    timeline: {
      removeSilence: false,
      silenceThresholdDb: -42,
      minSilenceMs: 650,
      keepPaddingMs: 120,
    },
    subtitles: {
      enabled: true,
      style: input.subtitleStyle ?? 'clean',
      maxCharsPerCue: 18,
    },
    creative: {
      preset: 'clean',
      motion: 'none',
      captions: 'static',
      colorGrade: 'natural',
      soundEffects: 'off',
      emphasis: [],
      effects: [],
    },
    audio: { voiceVolume: 1 },
    backgroundMusic: { enabled: false, volume: 0.16 },
    intro: { enabled: false },
    outro: { enabled: false },
    cover: { timestampSeconds: 0 },
    export: { format: 'mp4', videoCodec: 'h264' },
  }
}

export function parseEditPlan(value: unknown): EditPlanV1 {
  if (!isRecord(value) || value.version !== 1) invalid('invalid_edit_plan', '剪辑计划必须是 EditPlan v1。')
  const ratio = value.ratio
  if (ratio !== '9:16' && ratio !== '1:1' && ratio !== '16:9') invalid('invalid_ratio', '画面比例无效。')

  const framing = value.framing === undefined
    ? createDefaultEditPlan().framing
    : parseFraming(value.framing)
  const timeline = value.timeline === undefined
    ? createDefaultEditPlan().timeline
    : parseTimeline(value.timeline)
  const subtitles = record(value.subtitles, 'invalid_subtitles', '字幕计划无效。')
  const style = subtitles.style
  if (style !== 'clean' && style !== 'bold' && style !== 'cyan') invalid('invalid_subtitle_style', '字幕样式无效。')
  const maxCharsPerCue = boundedNumber(subtitles.maxCharsPerCue, 6, 40, 'invalid_subtitle_length', '每条字幕字数必须在 6 到 40 之间。')
  const creative = value.creative === undefined
    ? createDefaultEditPlan().creative
    : parseCreative(value.creative)

  const audio = record(value.audio, 'invalid_audio_plan', '音频计划无效。')
  const voiceVolume = boundedNumber(audio.voiceVolume, 0, 2, 'invalid_voice_volume', '原声音量必须在 0 到 2 之间。')
  const backgroundMusic = optionalTrack(value.backgroundMusic, '背景音乐')
  const intro = optionalAsset(value.intro, '片头')
  const outro = optionalAsset(value.outro, '片尾')
  const cover = record(value.cover, 'invalid_cover_plan', '封面计划无效。')
  const timestampSeconds = boundedNumber(cover.timestampSeconds, 0, 86400, 'invalid_cover_timestamp', '封面时间点无效。')
  const output = record(value.export, 'invalid_export_plan', '导出计划无效。')
  if (output.format !== 'mp4' || output.videoCodec !== 'h264') invalid('unsupported_export', '首版只支持 H.264 MP4 导出。')

  return {
    version: 1,
    ratio,
    framing,
    timeline,
    subtitles: {
      enabled: boolean(subtitles.enabled, 'invalid_subtitles', '字幕开关无效。'),
      style,
      maxCharsPerCue,
    },
    creative,
    audio: { voiceVolume },
    backgroundMusic,
    intro,
    outro,
    cover: { timestampSeconds },
    export: { format: 'mp4', videoCodec: 'h264' },
  }
}

function parseCreative(value: unknown): EditPlanV1['creative'] {
  const creative = record(value, 'invalid_creative_plan', '创意剪辑计划无效。')
  if (creative.preset !== 'clean' && creative.preset !== 'energetic' && creative.preset !== 'cinematic') {
    invalid('invalid_creative_preset', '创意风格预设无效。')
  }
  if (creative.motion !== 'none' && creative.motion !== 'punch' && creative.motion !== 'dynamic') {
    invalid('invalid_creative_motion', '镜头运动计划无效。')
  }
  if (creative.captions !== 'static' && creative.captions !== 'karaoke' && creative.captions !== 'impact') {
    invalid('invalid_creative_captions', '动态字幕计划无效。')
  }
  if (creative.colorGrade !== 'natural' && creative.colorGrade !== 'vivid' && creative.colorGrade !== 'warm') {
    invalid('invalid_color_grade', '色彩风格无效。')
  }
  if (creative.soundEffects !== 'off' && creative.soundEffects !== 'subtle' && creative.soundEffects !== 'punch') {
    invalid('invalid_sound_effects', '音效风格无效。')
  }
  const hook = optionalDisplayText(creative.hook, 24, 'invalid_creative_hook', '开场钩子不能超过 24 个字符。')
  if (!Array.isArray(creative.emphasis) || creative.emphasis.length > 8) {
    invalid('invalid_creative_emphasis', '重点词必须是不超过 8 项的数组。')
  }
  const emphasis = creative.emphasis.map((item) =>
    requiredDisplayText(item, 12, 'invalid_creative_emphasis', '每个重点词不能超过 12 个字符。'),
  )
  if (!Array.isArray(creative.effects) || creative.effects.length > 5 || !creative.effects.every(isRemotionEffectId)) {
    invalid('invalid_creative_effects', 'Remotion 动效必须来自内置注册表且不超过 5 项。')
  }
  return {
    preset: creative.preset,
    motion: creative.motion,
    captions: creative.captions,
    colorGrade: creative.colorGrade,
    soundEffects: creative.soundEffects,
    ...(hook ? { hook } : {}),
    emphasis,
    effects: [...new Set(creative.effects)],
  }
}

function parseFraming(value: unknown): EditPlanV1['framing'] {
  const framing = record(value, 'invalid_framing', '画面构图计划无效。')
  if (framing.mode !== 'cover' && framing.mode !== 'contain') {
    invalid('invalid_framing_mode', '画面构图只能是裁满或完整显示。')
  }
  return { mode: framing.mode }
}

function parseTimeline(value: unknown): EditPlanV1['timeline'] {
  const timeline = record(value, 'invalid_timeline', '时间线计划无效。')
  return {
    removeSilence: boolean(timeline.removeSilence, 'invalid_timeline', '去除停顿开关无效。'),
    silenceThresholdDb: boundedNumber(
      timeline.silenceThresholdDb,
      -60,
      -20,
      'invalid_silence_threshold',
      '静音阈值必须在 -60dB 到 -20dB 之间。',
    ),
    minSilenceMs: boundedNumber(
      timeline.minSilenceMs,
      350,
      3000,
      'invalid_silence_duration',
      '最短静音时长必须在 350 到 3000 毫秒之间。',
    ),
    keepPaddingMs: boundedNumber(
      timeline.keepPaddingMs,
      0,
      500,
      'invalid_silence_padding',
      '停顿留白必须在 0 到 500 毫秒之间。',
    ),
  }
}

function optionalTrack(value: unknown, label: string): EditPlanV1['backgroundMusic'] {
  const track = record(value, 'invalid_background_music', `${label}计划无效。`)
  const enabled = boolean(track.enabled, 'invalid_background_music', `${label}开关无效。`)
  const assetId = optionalAssetId(track.assetId)
  if (enabled && !assetId) invalid('missing_background_music_asset', `启用${label}前必须选择真实素材。`)
  return {
    enabled,
    ...(assetId ? { assetId } : {}),
    volume: boundedNumber(track.volume, 0, 1, 'invalid_background_music_volume', `${label}音量必须在 0 到 1 之间。`),
  }
}

function optionalAsset(value: unknown, label: string): EditPlanV1['intro'] {
  const item = record(value, 'invalid_optional_asset', `${label}计划无效。`)
  const enabled = boolean(item.enabled, 'invalid_optional_asset', `${label}开关无效。`)
  const assetId = optionalAssetId(item.assetId)
  if (enabled && !assetId) invalid('missing_optional_asset', `启用${label}前必须选择真实素材。`)
  return { enabled, ...(assetId ? { assetId } : {}) }
}

function optionalAssetId(value: unknown) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    invalid('invalid_asset_id', '素材 id 无效。')
  }
  return value
}

function optionalDisplayText(value: unknown, maxLength: number, code: string, message: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(code, message)
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) invalid(code, message)
  return normalized
}

function requiredDisplayText(value: unknown, maxLength: number, code: string, message: string) {
  const normalized = optionalDisplayText(value, maxLength, code, message)
  if (!normalized) invalid(code, message)
  return normalized
}

function boundedNumber(value: unknown, min: number, max: number, code: string, message: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(code, message)
  return value
}

function boolean(value: unknown, code: string, message: string) {
  if (typeof value !== 'boolean') invalid(code, message)
  return value
}

function record(value: unknown, code: string, message: string) {
  if (!isRecord(value)) invalid(code, message)
  return value
}

function invalid(code: string, message: string): never {
  throw new EditPlanValidationError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
