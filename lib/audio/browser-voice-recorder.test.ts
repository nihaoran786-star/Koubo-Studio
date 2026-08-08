// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { encodeAudioBufferAsMonoWav, startBrowserVoiceRecording } from './browser-voice-recorder'

describe('browser voice recorder', () => {
  it('records, releases the microphone and converts supported browser audio to WAV', async () => {
    const stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    const result = await startBrowserVoiceRecording({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      MediaRecorderCtor: FakeMediaRecorder as unknown as typeof MediaRecorder,
      AudioContextCtor: createAudioContext(10) as unknown as typeof AudioContext,
      now: () => 123,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const stopped = await result.recorder.stop()

    expect(stopped.status).toBe('ok')
    if (stopped.status !== 'ok') return
    expect(stopped.file.name).toBe('voice-recording-123.wav')
    expect(stopped.file.type).toBe('audio/wav')
    expect(new TextDecoder().decode((await stopped.file.arrayBuffer()).slice(0, 4))).toBe('RIFF')
    expect(stopped.durationSeconds).toBe(10)
    expect(stopTrack).toHaveBeenCalled()
  })

  it('returns a clear permission error without creating a recorder', async () => {
    const error = new DOMException('denied', 'NotAllowedError')
    const result = await startBrowserVoiceRecording({
      mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(error)) },
      MediaRecorderCtor: FakeMediaRecorder as unknown as typeof MediaRecorder,
      AudioContextCtor: createAudioContext(10) as unknown as typeof AudioContext,
    })

    expect(result).toEqual({
      status: 'error',
      error: {
        code: 'microphone_permission_denied',
        message: '麦克风权限被拒绝，请在系统或浏览器设置中允许后重试。',
      },
    })
  })

  it('rejects a recording shorter than the clone reference minimum and releases tracks', async () => {
    const stopTrack = vi.fn()
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream
    const result = await startBrowserVoiceRecording({
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
      MediaRecorderCtor: FakeMediaRecorder as unknown as typeof MediaRecorder,
      AudioContextCtor: createAudioContext(7.5) as unknown as typeof AudioContext,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(await result.recorder.stop()).toEqual({
      status: 'error',
      error: {
        code: 'recording_duration_out_of_range',
        message: '录音需为 8-12 秒，当前约 7.5 秒。',
      },
    })
    expect(stopTrack).toHaveBeenCalled()
  })

  it('encodes multiple channels into a mono PCM WAV', async () => {
    const wav = encodeAudioBufferAsMonoWav({
      sampleRate: 8000,
      length: 2,
      numberOfChannels: 2,
      getChannelData: (channel: number) => channel === 0 ? new Float32Array([1, -1]) : new Float32Array([0, 0]),
    } as AudioBuffer)
    const view = new DataView(await wav.arrayBuffer())
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getInt16(44, true)).toBeGreaterThan(0)
    expect(view.getInt16(46, true)).toBeLessThan(0)
  })
})

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true
  }

  state: RecordingState = 'inactive'
  mimeType = 'audio/webm;codecs=opus'

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super()
    if (options?.mimeType) this.mimeType = options.mimeType
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.dispatchEvent(new MessageEvent('dataavailable', { data: new Blob(['recorded']) }))
    this.dispatchEvent(new Event('stop'))
  }
}

function createAudioContext(duration: number) {
  return class FakeAudioContext {
    decodeAudioData = vi.fn(async () => ({
      duration,
      sampleRate: 16000,
      length: 4,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0, 0.25, -0.25, 0]),
    }))
    close = vi.fn(async () => undefined)
  }
}
