import { describe, expect, it } from 'vitest'
import { normalizeVoiceGenerationParameters, VoiceGenerationValidationError } from './voice-generation'

describe('normalizeVoiceGenerationParameters', () => {
  it('normalizes text, speed, emotion, seed, and output format', () => {
    expect(
      normalizeVoiceGenerationParameters({
        scriptArtifactId: 'script-001',
        text: '  生成一段口播音频  ',
        referenceAudioPath: 'files/ref.wav',
        speed: 1.25,
        emotionText: '自然清晰',
        emotionAlpha: 0.3,
        emotionReferenceAudioPath: 'files/emotion.wav',
        seed: 123,
        trimSeconds: 10,
        useRandom: false,
        outputFormat: 'wav',
      }),
    ).toEqual({
      scriptArtifactId: 'script-001',
      text: '生成一段口播音频',
      referenceAudioPath: 'files/ref.wav',
      speed: 1.25,
      emotionText: '自然清晰',
      emotionAlpha: 0.3,
      emotionReferenceAudioPath: 'files/emotion.wav',
      seed: 123,
      trimSeconds: 10,
      useRandom: false,
      outputFormat: 'wav',
    })
  })

  it('rejects invalid speed, emotion alpha, and trim seconds', () => {
    expect(() =>
      normalizeVoiceGenerationParameters({
        scriptArtifactId: 'script-001',
        text: '测试',
        speed: 2.5,
        emotionAlpha: 0.5,
      }),
    ).toThrow(VoiceGenerationValidationError)

    expect(() =>
      normalizeVoiceGenerationParameters({
        scriptArtifactId: 'script-001',
        text: '测试',
        speed: 1,
        emotionAlpha: -0.1,
      }),
    ).toThrow(VoiceGenerationValidationError)

    expect(() =>
      normalizeVoiceGenerationParameters({
        scriptArtifactId: 'script-001',
        text: '测试',
        speed: 1,
        emotionAlpha: 0.2,
        trimSeconds: 601,
      }),
    ).toThrow(VoiceGenerationValidationError)
  })

  it('drops a fixed seed when random generation is enabled', () => {
    expect(
      normalizeVoiceGenerationParameters({
        scriptArtifactId: 'script-001',
        text: '测试',
        speed: 1,
        emotionAlpha: 0.2,
        seed: 123,
        useRandom: true,
      }),
    ).toMatchObject({
      seed: undefined,
      useRandom: true,
    })
  })
})
