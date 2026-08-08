'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Mic, Pause, Play, Trash2, Upload } from 'lucide-react'
import { PrimaryButton } from './chamber-shell'
import { StatusPill } from './status-pill'
import { useAudioAssetUpload } from '@/lib/audio/use-audio-asset-upload'
import {
  startBrowserVoiceRecording,
  type BrowserVoiceRecorderHandle,
} from '@/lib/audio/browser-voice-recorder'
import { useIndexTTS2 } from '@/lib/audio/use-indextts2'
import { useLatestAudioArtifact } from '@/lib/audio/use-latest-audio-artifact'
import { audioArtifactFileEndpoint } from '@/lib/audio/audio-artifact-client'
import {
  audioAssetFileEndpoint,
  deleteAudioAssetClient,
  listAudioAssetsClient,
} from '@/lib/audio/audio-asset-client'
import type { AudioAsset } from '@/lib/audio/audio-asset'
import type { AudioOutputFormat } from '@/lib/audio/voice-generation'
import { cn } from '@/lib/utils'

const BARS = Array.from({ length: 20 })
const MIN_REFERENCE_AUDIO_SECONDS = 8
const MAX_REFERENCE_AUDIO_SECONDS = 12

type Source = 'library' | 'record'

export function VoiceChamber({
  projectId,
  scriptArtifactId,
  scriptText,
  onAudioReady,
  onNext,
  onPrev,
}: {
  projectId: string
  scriptArtifactId?: string
  scriptText: string
  onAudioReady?: (artifactId: string) => void
  onNext: () => void
  onPrev: () => void
}) {
  const [phase, setPhase] = useState<'empty' | 'building' | 'ready'>('empty')
  const [source, setSource] = useState<Source>('library')
  const [assets, setAssets] = useState<AudioAsset[]>([])
  const [assetsStatus, setAssetsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [assetError, setAssetError] = useState<string>()
  const [selectedReferenceAssetId, setSelectedReferenceAssetId] = useState<string>()
  const [selectedEmotionAssetId, setSelectedEmotionAssetId] = useState<string>()
  const [speed, setSpeed] = useState(1)
  const [emotionAlpha, setEmotionAlpha] = useState(0.2)
  const [emotionText, setEmotionText] = useState('自然、清晰、稳定的中文口播，中英文切换流畅。')
  const [useRandom, setUseRandom] = useState(false)
  const [seed, setSeed] = useState(7)
  const [trimSeconds, setTrimSeconds] = useState(10)
  const [outputFormat, setOutputFormat] = useState<AudioOutputFormat>('wav')
  const [referencePath, setReferencePath] = useState<string>()
  const [referenceName, setReferenceName] = useState<string>()
  const [referenceValidation, setReferenceValidation] = useState<{
    status: 'idle' | 'checking' | 'valid' | 'invalid' | 'unknown'
    message?: string
  }>({ status: 'idle' })
  const [emotionReferencePath, setEmotionReferencePath] = useState<string>()
  const [emotionReferenceName, setEmotionReferenceName] = useState<string>()
  const [emotionReferenceValidation, setEmotionReferenceValidation] = useState<{
    status: 'idle' | 'checking' | 'valid' | 'invalid' | 'unknown'
    message?: string
  }>({ status: 'idle' })
  const [previewOnly, setPreviewOnly] = useState(false)
  const [recordingStatus, setRecordingStatus] = useState<
    'idle' | 'requesting' | 'recording' | 'processing' | 'ready' | 'error'
  >('idle')
  const [recordingMessage, setRecordingMessage] = useState<string>()
  const [recording, setRecording] = useState(false)
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0)
  const [playing, setPlaying] = useState(false)
  const recorderRef = useRef<BrowserVoiceRecorderHandle | undefined>(undefined)
  const previewAudioRef = useRef<HTMLAudioElement>(null)
  const audio = useIndexTTS2(projectId)
  const latestAudio = useLatestAudioArtifact(projectId, { scriptArtifactId })
  const referenceUpload = useAudioAssetUpload(projectId)
  const emotionUpload = useAudioAssetUpload(projectId)

  const audioErrorMessage = audio.lastResult?.status !== 'ok' ? audio.lastResult?.error.message : undefined
  const referenceAssets = assets.filter(
    (asset) => asset.status === 'ready' && (asset.purpose === 'reference' || asset.purpose === 'recording'),
  )
  const emotionAssets = assets.filter(
    (asset) => asset.status === 'ready' && asset.purpose === 'emotion',
  )
  const referencePreviewUrl = selectedReferenceAssetId
    ? audioAssetFileEndpoint(projectId, selectedReferenceAssetId)
    : undefined
  const generatedPreviewUrl = latestAudio.selected?.playbackUrl
  const previewUrl = generatedPreviewUrl ?? referencePreviewUrl

  const refreshAssets = useCallback(async () => {
    setAssetsStatus('loading')
    const result = await listAudioAssetsClient(projectId)
    if (result.status === 'ok' && 'assets' in result) {
      setAssets(result.assets.filter((asset) => asset.status === 'ready'))
      setAssetsStatus('ready')
      setAssetError(undefined)
      return
    }
    setAssetsStatus('error')
    setAssetError(result.status === 'ok' ? '声音素材列表格式无效。' : result.error.message)
  }, [projectId])

  useEffect(() => {
    void refreshAssets()
  }, [refreshAssets])

  useEffect(() => () => {
    recorderRef.current?.cancel()
    recorderRef.current = undefined
  }, [])

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(() => {
      setRecordingElapsedSeconds((seconds) => seconds + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [recording])

  function selectReferenceAsset(asset: AudioAsset) {
    setSelectedReferenceAssetId(asset.assetId)
    setReferencePath(asset.relativePath)
    setReferenceName(asset.originalFilename)
    setReferenceValidation({ status: 'valid', message: '已选择真实声音素材；生成时会再次校验时长。' })
    setSource(asset.purpose === 'recording' ? 'record' : 'library')
    setPhase('empty')
  }

  function selectEmotionAsset(asset: AudioAsset | undefined) {
    setSelectedEmotionAssetId(asset?.assetId)
    setEmotionReferencePath(asset?.relativePath)
    setEmotionReferenceName(asset?.originalFilename)
    setEmotionReferenceValidation(
      asset
        ? { status: 'valid', message: '已选择真实情绪参考素材；生成时会再次校验时长。' }
        : { status: 'idle' },
    )
  }

  async function deleteAsset(asset: AudioAsset) {
    const result = await deleteAudioAssetClient(projectId, asset.assetId)
    if (result.status !== 'ok') {
      setAssetError(result.error.message)
      return
    }
    if (asset.assetId === selectedReferenceAssetId) {
      setSelectedReferenceAssetId(undefined)
      setReferencePath(undefined)
      setReferenceName(undefined)
      setReferenceValidation({ status: 'idle' })
    }
    if (asset.assetId === selectedEmotionAssetId) selectEmotionAsset(undefined)
    await refreshAssets()
  }

  async function build() {
    if (!referencePath) return
    setPhase('building')
    setRecording(false)
    const result = await audio.generate({
      sessionId: 'voice-session',
      parameters: {
        scriptArtifactId: scriptArtifactId ?? '',
        text: scriptText.trim() || '请先在文案页生成或填写口播正文。',
        referenceAudioPath: referencePath,
        speed,
        emotionText,
        emotionAlpha,
        emotionReferenceAudioPath: emotionReferencePath,
        trimSeconds: previewOnly ? trimSeconds : undefined,
        seed: useRandom ? undefined : seed,
        useRandom,
        outputFormat,
      },
    })
    if (result.status === 'ok') {
      latestAudio.selectFromGeneration({
        artifactId: result.artifact.artifactId,
        outputPath: result.artifact.outputPath,
        durationSeconds: result.artifact.durationSeconds,
        playbackUrl: audioArtifactFileEndpoint(projectId, result.artifact.artifactId),
        createdAt: result.artifact.createdAt,
      })
      onAudioReady?.(result.artifact.artifactId)
      setPhase('ready')
      return
    }
    setPhase('empty')
  }

  async function togglePreview() {
    const element = previewAudioRef.current
    if (!element || !previewUrl) return
    if (!element.paused) {
      element.pause()
      return
    }
    await element.play().catch(() => setPlaying(false))
  }

  async function uploadReference(file: File | undefined) {
    if (!file) return
    setReferenceValidation({ status: 'checking', message: '正在检查参考音频时长…' })
    const duration = await probeBrowserAudioDuration(file)
    if (duration.status === 'ok') {
      const validation = validateReferenceAudioDurationSeconds(duration.durationSeconds)
      if (validation.status === 'invalid') {
        setReferencePath(undefined)
        setReferenceName(undefined)
        setReferenceValidation(validation)
        return
      }
      setReferenceValidation(validation)
    } else {
      setReferenceValidation({ status: 'unknown', message: '浏览器无法预读时长，生成时会再次校验。' })
    }
    const result = await referenceUpload.upload({ purpose: 'reference', file })
    if (result.status === 'ok') {
      selectReferenceAsset(result.asset)
      await refreshAssets()
    }
  }

  async function uploadEmotionReference(file: File | undefined) {
    if (!file) return
    setEmotionReferenceValidation({ status: 'checking', message: '正在检查情绪参考音频时长…' })
    const duration = await probeBrowserAudioDuration(file)
    if (duration.status === 'ok') {
      const validation = validateEmotionReferenceAudioDurationSeconds(duration.durationSeconds)
      if (validation.status === 'invalid') {
        selectEmotionAsset(undefined)
        setEmotionReferenceValidation(validation)
        return
      }
      setEmotionReferenceValidation(validation)
    } else {
      setEmotionReferenceValidation({ status: 'unknown', message: '浏览器无法预读情绪时长，生成时会再次校验。' })
    }
    const result = await emotionUpload.upload({ purpose: 'emotion', file })
    if (result.status === 'ok') {
      selectEmotionAsset(result.asset)
      await refreshAssets()
    }
  }

  async function startRecording() {
    recorderRef.current?.cancel()
    recorderRef.current = undefined
    setRecordingMessage(undefined)
    setRecordingElapsedSeconds(0)
    setRecordingStatus('requesting')
    const result = await startBrowserVoiceRecording()
    if (result.status !== 'ok') {
      setRecording(false)
      setRecordingStatus('error')
      setRecordingMessage(result.error.message)
      return
    }
    recorderRef.current = result.recorder
    setRecording(true)
    setRecordingStatus('recording')
    setRecordingMessage('正在录音，请朗读 8-12 秒后点击停止录音。')
  }

  async function stopRecording() {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = undefined
    setRecording(false)
    setRecordingStatus('processing')
    setRecordingMessage('正在停止录音并转换为 WAV…')
    const recordingResult = await recorder.stop()
    if (recordingResult.status !== 'ok') {
      setRecordingStatus('error')
      setRecordingMessage(recordingResult.error.message)
      return
    }
    setRecordingMessage('正在保存录音…')
    const uploadResult = await referenceUpload.upload({ purpose: 'recording', file: recordingResult.file })
    if (uploadResult.status !== 'ok') {
      setRecordingStatus('error')
      setRecordingMessage(uploadResult.error.message)
      return
    }
    selectReferenceAsset(uploadResult.asset)
    setReferenceValidation(validateReferenceAudioDurationSeconds(recordingResult.durationSeconds))
    setRecordingStatus('ready')
    setRecordingMessage(`录音约 ${recordingResult.durationSeconds.toFixed(1)} 秒，已保存，可直接生成克隆声音。`)
    await refreshAssets()
  }

  const hasReadyAudio = phase === 'ready' || latestAudio.status === 'done'
  const animating = phase === 'building' || recording || playing
  const idle = phase === 'empty' && !recording && !playing && !hasReadyAudio
  const caption = phase === 'building' || audio.status === 'running'
    ? '正在调用 IndexTTS2 生成音频…'
    : hasReadyAudio
      ? '生成音频已就绪，可真实试听'
      : audioErrorMessage ?? (referenceName ? `已选择：${referenceName}` : '请选择或导入真实声音素材')

  return (
    <div className="relative flex min-h-[calc(100dvh-84px)] w-full flex-col items-center justify-center overflow-hidden pt-2">
      <div className="flow-action-dock">
        {hasReadyAudio ? (
          <PrimaryButton tone="ghost" onClick={onNext} className="flow-next-button">下一步</PrimaryButton>
        ) : phase === 'building' || audio.status === 'running' ? (
          <PrimaryButton tone="ghost" loading disabled className="flow-next-button">生成音频中</PrimaryButton>
        ) : (
          <PrimaryButton tone="ghost" onClick={build} disabled={!referencePath} className="flow-next-button">生成音频</PrimaryButton>
        )}
      </div>

      <div className="room-light relative flex w-full items-center justify-center">
        <div className="relative animate-float-slow">
          <button
            type="button"
            onClick={() => void togglePreview()}
            disabled={!previewUrl}
            aria-label="试听真实声音"
            className="group relative flex size-64 items-center justify-center disabled:cursor-not-allowed md:size-72"
          >
            <div className="absolute inset-0 rounded-full border border-line" />
            <div className={cn('absolute inset-7 rounded-full border border-cyan/40', animating && 'animate-pulse-ring')} />
            <svg viewBox="0 0 200 200" className="absolute inset-0 size-full" aria-hidden>
              {Array.from({ length: 24 }).map((_, index) => {
                const angle = (index / 24) * Math.PI * 2
                const length = idle ? 5 : 5 + ((Math.sin(index * 1.7) + 1) / 2) * 24
                return (
                  <line
                    key={index}
                    x1={100 + Math.cos(angle) * 58}
                    y1={100 + Math.sin(angle) * 58}
                    x2={100 + Math.cos(angle) * (58 + length)}
                    y2={100 + Math.sin(angle) * (58 + length)}
                    stroke={idle ? 'var(--line)' : 'var(--cyan)'}
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={animating ? 1 : previewUrl ? 0.85 : 0.5}
                  />
                )
              })}
            </svg>
            <div className="glass relative flex size-32 flex-col items-center justify-center rounded-full">
              {playing ? <Pause className="size-8 text-cyan" /> : previewUrl ? <Play className="size-8 text-cyan" /> : <Mic className="size-8 text-sub" />}
              <span className="mt-1.5 font-mono text-[10px] tracking-widest text-sub">{previewUrl ? 'PLAY' : 'NO AUDIO'}</span>
            </div>
          </button>
          {previewUrl ? (
            <audio
              ref={previewAudioRef}
              aria-label="真实声音预览播放器"
              src={previewUrl}
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
          ) : null}
        </div>
      </div>

      <div className="relative z-10 mt-2 flex w-full max-w-3xl flex-col items-center gap-4 px-4 pb-8">
        <div className={cn('flex h-8 w-full max-w-xl items-center justify-center gap-[4px]', animating && 'animate-pulse')}>
          {BARS.map((_, index) => (
            <span
              key={index}
              className="w-[3px] rounded-full"
              style={{
                background: idle ? 'var(--line)' : 'var(--cyan)',
                height: previewUrl ? 4 + ((index * 13) % 18) : 4,
              }}
            />
          ))}
        </div>
        <p className="text-center text-[13px] text-sub">{caption}</p>

        {hasReadyAudio && latestAudio.selected ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <StatusPill label={`音频 ${latestAudio.selected.artifactId}`} tone="success" />
            <StatusPill label={`${latestAudio.selected.durationSeconds.toFixed(1)} 秒`} tone="cyan" />
            <audio aria-label="试听生成音频" controls src={latestAudio.selected.playbackUrl} className="h-8 max-w-xs" />
          </div>
        ) : null}

        {!hasReadyAudio ? (
          <div className="grid w-full gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="panel grid content-start gap-3 rounded-3xl p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">我的声音素材</p>
                  <p className="mt-1 text-xs text-sub">只显示当前项目中真实保存的音频。</p>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs">
                  <Upload className="size-3.5" /> 导入
                  <input aria-label="上传声音参考音频" type="file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4" className="sr-only" onChange={(event) => void uploadReference(event.target.files?.[0])} />
                </label>
              </div>
              {assetsStatus === 'loading' ? <p className="text-xs text-sub">正在读取素材…</p> : null}
              {assetError ? <p className="text-xs text-danger">{assetError}</p> : null}
              {referenceAssets.length === 0 && assetsStatus === 'ready' ? (
                <p className="rounded-2xl border border-dashed border-line p-4 text-center text-xs text-sub">还没有声音素材，请导入 8–12 秒音频或录音。</p>
              ) : null}
              <div className="grid gap-2">
                {referenceAssets.map((asset) => {
                  const selected = asset.assetId === selectedReferenceAssetId
                  return (
                    <div key={asset.assetId} className={cn('flex items-center gap-2 rounded-2xl border p-2.5', selected ? 'border-cyan bg-cyan/5' : 'border-line')}>
                      <button type="button" onClick={() => selectReferenceAsset(asset)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium">{asset.originalFilename}</span>
                        <span className="text-[11px] text-sub">{asset.purpose === 'recording' ? '录音' : '导入'} · {(asset.size / 1024 / 1024).toFixed(1)} MB</span>
                      </button>
                      <audio aria-label={`试听 ${asset.originalFilename}`} controls preload="none" src={audioAssetFileEndpoint(projectId, asset.assetId)} className="h-8 w-32" />
                      {selected ? <Check className="size-4 text-cyan" /> : null}
                      <button type="button" aria-label={`删除 ${asset.originalFilename}`} onClick={() => void deleteAsset(asset)} className="rounded-full p-2 text-sub hover:bg-danger/10 hover:text-danger"><Trash2 className="size-3.5" /></button>
                    </div>
                  )
                })}
              </div>

              <div className="flex gap-2 border-t border-line pt-3">
                <button type="button" onClick={() => setSource('library')} className={cn('rounded-full px-3 py-1.5 text-xs', source === 'library' ? 'bg-foreground text-background' : 'bg-secondary text-sub')}>素材库</button>
                <button type="button" onClick={() => setSource('record')} className={cn('rounded-full px-3 py-1.5 text-xs', source === 'record' ? 'bg-foreground text-background' : 'bg-secondary text-sub')}>录音克隆</button>
              </div>
              {source === 'record' ? (
                <div className="grid gap-2 rounded-2xl border border-line p-3 text-center text-xs">
                  <p className="text-sub">安静环境下自然朗读 8–12 秒。</p>
                  <button type="button" aria-label={recording ? '停止录音' : '开始录音'} onClick={() => void (recording ? stopRecording() : startRecording())} disabled={recordingStatus === 'requesting' || recordingStatus === 'processing'} className={cn('inline-flex h-10 items-center justify-center gap-2 rounded-full font-medium', recording ? 'bg-danger text-white' : 'bg-foreground text-background')}>
                    {recording ? <Pause className="size-4" /> : <Mic className="size-4" />}
                    {recording ? `${recordingElapsedSeconds}s · 停止并保存` : recordingStatus === 'processing' ? '正在转换 WAV…' : '开始录音'}
                  </button>
                  <p className={recordingStatus === 'error' ? 'text-danger' : 'text-sub'}>{recordingMessage ?? '录音完成后会自动进入素材库。'}</p>
                </div>
              ) : null}
            </section>

            <section className="panel grid content-start gap-3 rounded-3xl p-4 text-xs text-sub">
              <p className="text-sm font-semibold text-foreground">生成参数</p>
              <label className="grid gap-1">语速 <input aria-label="语速" type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
              <label className="grid gap-1">情绪强度 <input aria-label="情绪强度" type="range" min="0" max="1" step="0.05" value={emotionAlpha} onChange={(event) => setEmotionAlpha(Number(event.target.value))} /></label>
              <label className="grid gap-1">情绪提示 <input aria-label="情绪提示" value={emotionText} onChange={(event) => setEmotionText(event.target.value)} className="rounded-full border border-line bg-background px-3 py-2 text-foreground" /></label>
              <label className="grid gap-1">情绪参考素材
                <select aria-label="选择情绪参考素材" value={selectedEmotionAssetId ?? ''} onChange={(event) => selectEmotionAsset(emotionAssets.find((asset) => asset.assetId === event.target.value))} className="rounded-full border border-line bg-background px-3 py-2 text-foreground">
                  <option value="">不使用</option>
                  {emotionAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.originalFilename}</option>)}
                </select>
              </label>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line px-3 py-2"><Upload className="size-3.5" />{emotionReferenceName ? `情绪参考：${emotionReferenceName}` : '导入情绪参考'}<input aria-label="上传情绪参考音频" type="file" accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4" className="sr-only" onChange={(event) => void uploadEmotionReference(event.target.files?.[0])} /></label>
              {referenceValidation.message ? <span className={referenceValidation.status === 'invalid' ? 'text-danger' : ''}>{referenceValidation.message}</span> : null}
              {emotionReferenceValidation.message ? <span className={emotionReferenceValidation.status === 'invalid' ? 'text-danger' : ''}>{emotionReferenceValidation.message}</span> : null}
              <label className="inline-flex items-center gap-2"><input aria-label="随机种子" type="checkbox" checked={useRandom} onChange={(event) => setUseRandom(event.target.checked)} />使用随机种子</label>
              <label className="grid gap-1">固定种子 <input aria-label="固定种子" type="number" min="0" max="2147483647" value={seed} disabled={useRandom} onChange={(event) => setSeed(clampInteger(Number(event.target.value), 0, 2147483647, 7))} className="rounded-full border border-line bg-background px-3 py-2 text-foreground" /></label>
              <label className="inline-flex items-center gap-2"><input aria-label="10 秒测试音频" type="checkbox" checked={previewOnly} onChange={(event) => setPreviewOnly(event.target.checked)} />先生成测试音频</label>
              <label className="grid gap-1">测试音频秒数 <input aria-label="测试音频秒数" type="number" min="1" max="600" value={trimSeconds} disabled={!previewOnly} onChange={(event) => setTrimSeconds(clampInteger(Number(event.target.value), 1, 600, 10))} className="rounded-full border border-line bg-background px-3 py-2 text-foreground" /></label>
              <div className="grid grid-cols-2 gap-1 rounded-full border border-line p-1">
                {(['wav', 'mp3'] as const).map((format) => <button key={format} type="button" aria-pressed={outputFormat === format} onClick={() => setOutputFormat(format)} className={cn('rounded-full py-1.5', outputFormat === format && 'bg-secondary text-foreground')}>{format.toUpperCase()}</button>)}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function clampInteger(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function validateReferenceAudioDurationSeconds(durationSeconds: number): { status: 'valid' | 'invalid'; message: string } {
  if (durationSeconds < MIN_REFERENCE_AUDIO_SECONDS || durationSeconds > MAX_REFERENCE_AUDIO_SECONDS) {
    return { status: 'invalid', message: `声音参考音频需为 ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} 秒，当前约 ${durationSeconds.toFixed(1)} 秒。` }
  }
  return { status: 'valid', message: `声音参考音频约 ${durationSeconds.toFixed(1)} 秒，可用于克隆。` }
}

export function validateEmotionReferenceAudioDurationSeconds(durationSeconds: number): { status: 'valid' | 'invalid'; message: string } {
  if (durationSeconds < MIN_REFERENCE_AUDIO_SECONDS || durationSeconds > MAX_REFERENCE_AUDIO_SECONDS) {
    return { status: 'invalid', message: `情绪参考音频需为 ${MIN_REFERENCE_AUDIO_SECONDS}-${MAX_REFERENCE_AUDIO_SECONDS} 秒，当前约 ${durationSeconds.toFixed(1)} 秒。` }
  }
  return { status: 'valid', message: `情绪参考音频约 ${durationSeconds.toFixed(1)} 秒，可用于控制情绪。` }
}

async function probeBrowserAudioDuration(file: File): Promise<{ status: 'ok'; durationSeconds: number } | { status: 'unknown' }> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return { status: 'unknown' }
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const element = document.createElement('audio')
    const cleanup = () => {
      window.clearTimeout(timer)
      element.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
    }
    const finish = (durationSeconds?: number) => {
      cleanup()
      resolve(typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? { status: 'ok', durationSeconds }
        : { status: 'unknown' })
    }
    const timer = window.setTimeout(() => finish(), 250)
    element.preload = 'metadata'
    element.onloadedmetadata = () => finish(element.duration)
    element.onerror = () => finish()
    element.src = objectUrl
  })
}
