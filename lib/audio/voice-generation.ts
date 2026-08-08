export type AudioOutputFormat = 'wav' | 'mp3'

export interface VoiceGenerationParameters {
  scriptArtifactId?: string
  text: string
  referenceAudioPath?: string
  speed: number
  emotionText?: string
  emotionAlpha: number
  emotionReferenceAudioPath?: string
  seed?: number
  trimSeconds?: number
  useRandom: boolean
  outputFormat: AudioOutputFormat
}

export class VoiceGenerationValidationError extends Error {
  code = 'invalid_voice_parameters' as const
  source = 'voice_generation' as const

  constructor(message: string) {
    super(message)
    this.name = 'VoiceGenerationValidationError'
  }
}

export function normalizeVoiceGenerationParameters(input: unknown): VoiceGenerationParameters {
  if (typeof input !== 'object' || input === null) {
    throw new VoiceGenerationValidationError('parameters 必须是对象')
  }

  const value = input as Record<string, unknown>
  const scriptArtifactId = readString(value.scriptArtifactId, 'scriptArtifactId').trim()
  if (!scriptArtifactId) {
    throw new VoiceGenerationValidationError('scriptArtifactId 不能为空')
  }

  const text = readString(value.text, 'text').trim()
  if (!text) {
    throw new VoiceGenerationValidationError('text 不能为空')
  }
  if (text.length > 12000) {
    throw new VoiceGenerationValidationError('text 不能超过 12000 个字符')
  }

  const speed = readNumber(value.speed ?? 1, 'speed')
  if (speed < 0.5 || speed > 2) {
    throw new VoiceGenerationValidationError('speed 必须在 0.5 到 2 之间')
  }

  const emotionAlpha = readNumber(value.emotionAlpha ?? 0.2, 'emotionAlpha')
  if (emotionAlpha < 0 || emotionAlpha > 1) {
    throw new VoiceGenerationValidationError('emotionAlpha 必须在 0 到 1 之间')
  }

  const outputFormat = value.outputFormat === 'mp3' ? 'mp3' : 'wav'
  const useRandom = typeof value.useRandom === 'boolean' ? value.useRandom : false
  const seed = !useRandom && typeof value.seed === 'number' && Number.isInteger(value.seed) ? value.seed : undefined
  const trimSeconds = normalizeTrimSeconds(value.trimSeconds)

  return {
    scriptArtifactId,
    text,
    referenceAudioPath: optionalString(value.referenceAudioPath),
    speed,
    emotionText: optionalString(value.emotionText),
    emotionAlpha,
    emotionReferenceAudioPath: optionalString(value.emotionReferenceAudioPath),
    seed,
    trimSeconds,
    useRandom,
    outputFormat,
  }
}

function readString(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new VoiceGenerationValidationError(`${label} 必须是字符串`)
  }
  return value
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new VoiceGenerationValidationError(`${label} 必须是数字`)
  }
  return value
}

function normalizeTrimSeconds(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  const trimSeconds = readNumber(value, 'trimSeconds')
  if (trimSeconds < 0 || trimSeconds > 600) {
    throw new VoiceGenerationValidationError('trimSeconds 必须在 0 到 600 之间')
  }
  return trimSeconds > 0 ? trimSeconds : undefined
}
