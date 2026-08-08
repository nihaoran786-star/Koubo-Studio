import { describe, expect, it } from 'vitest'
import { createVoiceSegmentPlan, VoiceSegmentationError } from './audio-segmentation'

describe('createVoiceSegmentPlan', () => {
  it('keeps short text as a single segment', () => {
    expect(createVoiceSegmentPlan('第一句。第二句。', { maxChars: 50 })).toEqual({
      status: 'single',
      source: 'audio_segmentation',
      segments: ['第一句。第二句。'],
    })
  })

  it('splits long text by sentence boundaries', () => {
    const plan = createVoiceSegmentPlan('第一句很长很长。第二句也很长很长。第三句继续补充。', {
      maxChars: 12,
    })

    expect(plan).toMatchObject({
      status: 'segmented',
      source: 'audio_segmentation',
    })
    expect(plan.segments.length).toBeGreaterThan(1)
    expect(plan.segments.join('')).toBe('第一句很长很长。第二句也很长很长。第三句继续补充。')
  })

  it('rejects empty text as segment_failed', () => {
    expect(() => createVoiceSegmentPlan('', { maxChars: 12 })).toThrow(VoiceSegmentationError)
  })
})
