// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  validateEmotionReferenceAudioDurationSeconds,
  validateReferenceAudioDurationSeconds,
  VoiceChamber,
} from './voice-chamber'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  uploadReference: vi.fn(),
  uploadEmotion: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  selectFromGeneration: vi.fn(),
  listAssets: vi.fn(),
  deleteAsset: vi.fn(),
  uploadHookCalls: 0,
  indexTTS2Status: 'idle',
  indexTTS2LastResult: undefined as
    | undefined
    | {
        status: 'invalid_request'
        source: string
        error: {
          code: string
          message: string
        }
      },
}))

vi.mock('@/lib/audio/audio-asset-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/audio-asset-client')>()),
  listAudioAssetsClient: mocks.listAssets,
  deleteAudioAssetClient: mocks.deleteAsset,
}))

vi.mock('@/lib/audio/use-indextts2', () => ({
  useIndexTTS2: () => ({
    status: mocks.indexTTS2Status,
    lastResult: mocks.indexTTS2LastResult,
    generate: mocks.generate,
  }),
}))

vi.mock('@/lib/audio/browser-voice-recorder', () => ({
  startBrowserVoiceRecording: mocks.startRecording,
}))

vi.mock('@/lib/audio/use-audio-asset-upload', () => ({
  useAudioAssetUpload: vi.fn(() => {
    mocks.uploadHookCalls += 1
    return mocks.uploadHookCalls % 2 === 1
      ? {
      status: 'idle',
      upload: mocks.uploadReference,
        }
      : {
          status: 'idle',
          upload: mocks.uploadEmotion,
        }
  }),
}))

vi.mock('@/lib/audio/use-latest-audio-artifact', () => ({
  useLatestAudioArtifact: () => ({
    status: 'idle',
    selected: undefined,
    selectFromGeneration: mocks.selectFromGeneration,
  }),
}))

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'audio_asset', assets: [] })
  mocks.deleteAsset.mockResolvedValue({ status: 'ok', source: 'audio_asset', assetId: 'reference-001' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.uploadHookCalls = 0
  mocks.indexTTS2Status = 'idle'
  mocks.indexTTS2LastResult = undefined
})

describe('VoiceChamber', () => {
  it('classifies browser-readable reference audio duration before upload', () => {
    expect(validateReferenceAudioDurationSeconds(7.9)).toEqual({
      status: 'invalid',
      message: '声音参考音频需为 8-12 秒，当前约 7.9 秒。',
    })
    expect(validateReferenceAudioDurationSeconds(8)).toEqual({
      status: 'valid',
      message: '声音参考音频约 8.0 秒，可用于克隆。',
    })
    expect(validateReferenceAudioDurationSeconds(12)).toEqual({
      status: 'valid',
      message: '声音参考音频约 12.0 秒，可用于克隆。',
    })
    expect(validateReferenceAudioDurationSeconds(12.1)).toEqual({
      status: 'invalid',
      message: '声音参考音频需为 8-12 秒，当前约 12.1 秒。',
    })
  })

  it('classifies browser-readable emotion reference audio duration before upload', () => {
    expect(validateEmotionReferenceAudioDurationSeconds(7.9)).toEqual({
      status: 'invalid',
      message: '情绪参考音频需为 8-12 秒，当前约 7.9 秒。',
    })
    expect(validateEmotionReferenceAudioDurationSeconds(10)).toEqual({
      status: 'valid',
      message: '情绪参考音频约 10.0 秒，可用于控制情绪。',
    })
    expect(validateEmotionReferenceAudioDurationSeconds(12.1)).toEqual({
      status: 'invalid',
      message: '情绪参考音频需为 8-12 秒，当前约 12.1 秒。',
    })
  })

  it('lists and submits only real audio assets to IndexTTS2', async () => {
    mocks.listAssets.mockResolvedValue({
      status: 'ok',
      source: 'audio_asset',
      assets: [{
        assetId: 'reference-001', assetType: 'audio', projectId: 'demo', featureType: 'digital-human',
        purpose: 'reference', originalFilename: '我的声音.wav', contentType: 'audio/wav',
        relativePath: 'files/audio/reference-001.wav', path: 'C:/workspace/files/audio/reference-001.wav',
        size: 1024, status: 'ready', createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
      }],
    })
    mocks.generate.mockResolvedValue({
      status: 'ok', source: 'indextts2_service',
      artifact: { artifactId: 'audio-001', outputPath: 'C:/workspace/audio-001.wav', durationSeconds: 10, createdAt: '2026-06-11T00:00:00.000Z' },
    })
    const user = userEvent.setup()

    render(
      <VoiceChamber
        projectId="demo"
        scriptArtifactId="script-001"
        scriptText="今天测试声音参数。"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    expect(await screen.findByLabelText('试听 我的声音.wav')).toHaveAttribute('src', '/api/projects/demo/audio-assets/reference-001/file')
    expect(screen.queryByText('温柔女声')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^我的声音\.wav/ }))
    await user.click(screen.getByRole('button', { name: '生成音频' }))
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledWith({
      sessionId: 'voice-session',
      parameters: expect.objectContaining({ referenceAudioPath: 'files/audio/reference-001.wav' }),
    }))
  })

  it('maps IndexTTS2 UI controls to generation parameters', async () => {
    mocks.uploadReference.mockResolvedValue({
      status: 'ok',
      asset: {
        assetId: 'reference-uploaded',
        purpose: 'reference',
        relativePath: 'files/audio/reference.wav',
        originalFilename: 'reference.wav',
      },
    })
    mocks.uploadEmotion.mockResolvedValue({
      status: 'ok',
      asset: {
        assetId: 'emotion-uploaded',
        purpose: 'emotion',
        relativePath: 'files/audio/emotion.wav',
        originalFilename: 'emotion.wav',
      },
    })
    mocks.generate.mockResolvedValue({
      status: 'ok',
      source: 'indextts2_service',
      artifact: {
        artifactId: 'audio-001',
        outputPath: 'C:/workspace/artifacts/audio/audio-001.mp3',
        durationSeconds: 12,
        createdAt: '2026-06-11T00:00:00.000Z',
      },
    })
    const user = userEvent.setup()
    render(
      <VoiceChamber
        projectId="demo"
        scriptArtifactId="script-001"
        scriptText="今天测试声音参数。"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    await user.upload(screen.getByLabelText('上传声音参考音频'), new File(['ref'], 'reference.wav', { type: 'audio/wav' }))
    await user.upload(screen.getByLabelText('上传情绪参考音频'), new File(['emo'], 'emotion.wav', { type: 'audio/wav' }))
    await waitFor(() => expect(screen.getByText('已选择：reference.wav')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('情绪参考：emotion.wav')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('语速'), { target: { value: '1.25' } })
    fireEvent.change(screen.getByLabelText('情绪强度'), { target: { value: '0.65' } })
    fireEvent.change(screen.getByLabelText('情绪提示'), { target: { value: '兴奋但稳定，适合直播带货口播。' } })
    fireEvent.change(screen.getByLabelText('固定种子'), { target: { value: '123' } })
    await user.click(screen.getByLabelText('10 秒测试音频'))
    fireEvent.change(screen.getByLabelText('测试音频秒数'), { target: { value: '12' } })
    await user.click(screen.getByRole('button', { name: 'MP3' }))
    await user.click(screen.getByRole('button', { name: '生成音频' }))

    await waitFor(() => expect(mocks.generate).toHaveBeenCalled())
    expect(mocks.generate).toHaveBeenCalledWith({
      sessionId: 'voice-session',
      parameters: expect.objectContaining({
        scriptArtifactId: 'script-001',
        text: '今天测试声音参数。',
        referenceAudioPath: 'files/audio/reference.wav',
        speed: 1.25,
        emotionText: '兴奋但稳定，适合直播带货口播。',
        emotionAlpha: 0.65,
        emotionReferenceAudioPath: 'files/audio/emotion.wav',
        seed: 123,
        trimSeconds: 12,
        useRandom: false,
        outputFormat: 'mp3',
      }),
    })
  })

  it('records, converts and uploads a WAV before reusing IndexTTS2 generation', async () => {
    mocks.stopRecording.mockResolvedValue({
      status: 'ok',
      durationSeconds: 10,
      file: new File(['wav'], 'voice-recording-123.wav', { type: 'audio/wav' }),
    })
    mocks.startRecording.mockResolvedValue({
      status: 'ok',
      recorder: {
        stop: mocks.stopRecording,
        cancel: vi.fn(),
      },
    })
    mocks.uploadReference.mockResolvedValue({
      status: 'ok',
      asset: {
        assetId: 'recording-001',
        purpose: 'recording',
        relativePath: 'files/audio/recording-001.wav',
        originalFilename: 'voice-recording-123.wav',
      },
    })
    mocks.generate.mockResolvedValue({
      status: 'ok',
      source: 'indextts2_service',
      artifact: {
        artifactId: 'audio-recording-001',
        outputPath: 'C:/workspace/artifacts/audio/audio-recording-001.wav',
        durationSeconds: 12,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    })
    const user = userEvent.setup()

    render(
      <VoiceChamber
        projectId="demo"
        scriptArtifactId="script-001"
        scriptText="使用刚才的录音生成克隆声音。"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    await user.click(screen.getByRole('button', { name: '录音克隆' }))
    await user.click(screen.getByRole('button', { name: '开始录音' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止录音' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '停止录音' }))

    await waitFor(() => expect(screen.getByText(/已保存，可直接生成克隆声音/)).toBeInTheDocument())
    expect(mocks.uploadReference).toHaveBeenCalledWith({
      purpose: 'recording',
      file: expect.objectContaining({
        name: 'voice-recording-123.wav',
        type: 'audio/wav',
      }),
    })

    await user.click(screen.getByRole('button', { name: '生成音频' }))
    await waitFor(() => expect(mocks.generate).toHaveBeenCalled())
    expect(mocks.generate).toHaveBeenCalledWith({
      sessionId: 'voice-session',
      parameters: expect.objectContaining({
        scriptArtifactId: 'script-001',
        referenceAudioPath: 'files/audio/recording-001.wav',
      }),
    })
  })

  it('shows the service error when reference audio duration is out of range', async () => {
    mocks.indexTTS2Status = 'invalid_request'
    mocks.indexTTS2LastResult = {
      status: 'invalid_request',
      source: 'indextts2_service',
      error: {
        code: 'reference_audio_duration_out_of_range',
        message: '声音参考音频需为 8-12 秒，当前约 7.9 秒。',
      },
    }

    render(
      <VoiceChamber
        projectId="demo"
        scriptArtifactId="script-001"
        scriptText="今天测试声音参数。"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    expect(screen.getByText('声音参考音频需为 8-12 秒，当前约 7.9 秒。')).toBeInTheDocument()
  })
})
