const MIN_RECORDING_SECONDS = 8
const MAX_RECORDING_SECONDS = 12

export type BrowserVoiceRecordingErrorCode =
  | 'recording_not_supported'
  | 'microphone_permission_denied'
  | 'microphone_not_found'
  | 'recording_start_failed'
  | 'recording_empty'
  | 'recording_decode_failed'
  | 'recording_duration_out_of_range'

export type BrowserVoiceRecordingResult =
  | {
      status: 'ok'
      file: File
      durationSeconds: number
    }
  | {
      status: 'error'
      error: {
        code: BrowserVoiceRecordingErrorCode
        message: string
      }
    }

export interface BrowserVoiceRecorderHandle {
  stop: () => Promise<BrowserVoiceRecordingResult>
  cancel: () => void
}

export type StartBrowserVoiceRecordingResult =
  | {
      status: 'ok'
      recorder: BrowserVoiceRecorderHandle
    }
  | Extract<BrowserVoiceRecordingResult, { status: 'error' }>

interface BrowserVoiceRecorderDependencies {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  MediaRecorderCtor?: typeof MediaRecorder
  AudioContextCtor?: typeof AudioContext
  now?: () => number
}

export async function startBrowserVoiceRecording(
  dependencies: BrowserVoiceRecorderDependencies = {},
): Promise<StartBrowserVoiceRecordingResult> {
  const mediaDevices = dependencies.mediaDevices ?? globalThis.navigator?.mediaDevices
  const MediaRecorderCtor = dependencies.MediaRecorderCtor ?? globalThis.MediaRecorder
  const AudioContextCtor = dependencies.AudioContextCtor ?? globalThis.AudioContext

  if (!mediaDevices?.getUserMedia || !MediaRecorderCtor || !AudioContextCtor) {
    return recordingError('recording_not_supported', '当前浏览器不支持麦克风录音，请改用上传音频。')
  }

  let stream: MediaStream
  try {
    stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })
  } catch (error) {
    return classifyMicrophoneError(error)
  }

  try {
    const mimeType = selectRecordingMimeType(MediaRecorderCtor)
    const recorder = mimeType
      ? new MediaRecorderCtor(stream, { mimeType })
      : new MediaRecorderCtor(stream)
    const chunks: Blob[] = []
    let cancelled = false
    let stopped = false
    let stopPromise: Promise<BrowserVoiceRecordingResult> | undefined

    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.start(250)

    const releaseTracks = () => {
      for (const track of stream.getTracks()) track.stop()
    }

    return {
      status: 'ok',
      recorder: {
        stop() {
          if (stopPromise) return stopPromise
          stopPromise = new Promise((resolve) => {
            const finishWithError = (code: BrowserVoiceRecordingErrorCode, message: string) => {
              releaseTracks()
              resolve(recordingError(code, message))
            }
            recorder.addEventListener('error', () => {
              finishWithError('recording_start_failed', '麦克风录音失败，请检查设备后重试。')
            }, { once: true })
            recorder.addEventListener('stop', async () => {
              stopped = true
              releaseTracks()
              if (cancelled) {
                resolve(recordingError('recording_empty', '录音已取消。'))
                return
              }
              const recordedBlob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
              if (recordedBlob.size <= 0) {
                resolve(recordingError('recording_empty', '没有录到声音，请确认麦克风可用后重试。'))
                return
              }
              try {
                const converted = await convertRecordedBlobToWav(recordedBlob, AudioContextCtor)
                if (
                  converted.durationSeconds < MIN_RECORDING_SECONDS ||
                  converted.durationSeconds > MAX_RECORDING_SECONDS
                ) {
                  resolve(recordingError(
                    'recording_duration_out_of_range',
                    `录音需为 ${MIN_RECORDING_SECONDS}-${MAX_RECORDING_SECONDS} 秒，当前约 ${converted.durationSeconds.toFixed(1)} 秒。`,
                  ))
                  return
                }
                resolve({
                  status: 'ok',
                  durationSeconds: converted.durationSeconds,
                  file: new File(
                    [converted.wav],
                    `voice-recording-${(dependencies.now ?? Date.now)()}.wav`,
                    { type: 'audio/wav' },
                  ),
                })
              } catch {
                resolve(recordingError('recording_decode_failed', '录音无法转换为 WAV，请重试或改用上传音频。'))
              }
            }, { once: true })

            if (recorder.state === 'inactive') {
              finishWithError('recording_empty', '录音已停止，请重新录制。')
              return
            }
            recorder.stop()
          })
          return stopPromise
        },
        cancel() {
          cancelled = true
          releaseTracks()
          if (!stopped && recorder.state !== 'inactive') recorder.stop()
        },
      },
    }
  } catch {
    for (const track of stream.getTracks()) track.stop()
    return recordingError('recording_start_failed', '无法启动麦克风录音，请检查设备后重试。')
  }
}

function selectRecordingMimeType(MediaRecorderCtor: typeof MediaRecorder) {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find((type) => MediaRecorderCtor.isTypeSupported?.(type)) ?? ''
}

async function convertRecordedBlobToWav(blob: Blob, AudioContextCtor: typeof AudioContext) {
  const context = new AudioContextCtor()
  try {
    const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer())
    if (!Number.isFinite(audioBuffer.duration) || audioBuffer.duration <= 0) {
      throw new Error('invalid audio duration')
    }
    return {
      durationSeconds: audioBuffer.duration,
      wav: encodeAudioBufferAsMonoWav(audioBuffer),
    }
  } finally {
    await context.close()
  }
}

export function encodeAudioBufferAsMonoWav(audioBuffer: AudioBuffer) {
  const sampleRate = audioBuffer.sampleRate
  const frameCount = audioBuffer.length
  const channelCount = Math.max(1, audioBuffer.numberOfChannels)
  const bytesPerSample = 2
  const wav = new ArrayBuffer(44 + frameCount * bytesPerSample)
  const view = new DataView(wav)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, wav.byteLength - 8, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, frameCount * bytesPerSample, true)

  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index))
  let offset = 44
  for (let frame = 0; frame < frameCount; frame += 1) {
    const mixed = channels.reduce((sum, channel) => sum + (channel[frame] ?? 0), 0) / channelCount
    const sample = Math.max(-1, Math.min(1, mixed))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += bytesPerSample
  }
  return new Blob([wav], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function classifyMicrophoneError(error: unknown): Extract<BrowserVoiceRecordingResult, { status: 'error' }> {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return recordingError('microphone_permission_denied', '麦克风权限被拒绝，请在系统或浏览器设置中允许后重试。')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return recordingError('microphone_not_found', '没有找到可用麦克风，请连接设备后重试。')
  }
  return recordingError('recording_start_failed', '无法访问麦克风，请检查设备占用和系统权限。')
}

function recordingError(code: BrowserVoiceRecordingErrorCode, message: string) {
  return {
    status: 'error' as const,
    error: { code, message },
  }
}
