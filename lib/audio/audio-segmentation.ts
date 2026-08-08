export type VoiceSegmentPlan =
  | {
      status: 'single'
      source: 'audio_segmentation'
      segments: string[]
    }
  | {
      status: 'segmented'
      source: 'audio_segmentation'
      segments: string[]
    }

export class VoiceSegmentationError extends Error {
  code = 'segment_failed' as const
  source = 'audio_segmentation' as const

  constructor(message: string) {
    super(message)
    this.name = 'VoiceSegmentationError'
  }
}

export function createVoiceSegmentPlan(
  text: string,
  options: { maxChars?: number } = {},
): VoiceSegmentPlan {
  const normalized = text.trim()
  if (!normalized) {
    throw new VoiceSegmentationError('待生成文本不能为空')
  }

  const maxChars = options.maxChars ?? 600
  if (normalized.length <= maxChars) {
    return {
      status: 'single',
      source: 'audio_segmentation',
      segments: [normalized],
    }
  }

  const sentences = normalized.match(/[^。！？!?]+[。！？!?]?/g) ?? [normalized]
  const segments: string[] = []
  let current = ''

  for (const sentence of sentences) {
    if (!current) {
      current = sentence
      continue
    }
    if ((current + sentence).length > maxChars) {
      segments.push(current)
      current = sentence
    } else {
      current += sentence
    }
  }
  if (current) segments.push(current)

  if (segments.some((segment) => segment.length > maxChars * 2)) {
    throw new VoiceSegmentationError('存在过长句子，无法安全分段')
  }

  return {
    status: 'segmented',
    source: 'audio_segmentation',
    segments,
  }
}
