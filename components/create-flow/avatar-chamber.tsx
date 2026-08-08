'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Trash2, Upload, Video } from 'lucide-react'
import type { AvatarAsset } from '@/lib/digital-human/avatar-asset'
import {
  avatarAssetFileEndpoint,
  deleteAvatarAssetClient,
  listAvatarAssetsClient,
} from '@/lib/digital-human/avatar-asset-client'
import { renderArtifactFileEndpoint } from '@/lib/digital-human/heygem-client'
import { useAvatarAssetUpload } from '@/lib/digital-human/use-avatar-asset-upload'
import { useDigitalHumanRuntime } from '@/lib/digital-human/use-digital-human-runtime'
import { useHeyGem } from '@/lib/digital-human/use-heygem'
import { PrimaryButton } from './chamber-shell'

type AssetsStatus = 'loading' | 'ready' | 'failed'
type PreviewStatus = 'idle' | 'loading' | 'ready' | 'failed'

export function AvatarChamber({
  projectId,
  scriptArtifactId,
  audioArtifactId,
  onNext,
  onPrev: _onPrev,
  onOpenSettings = () => undefined,
}: {
  projectId: string
  scriptArtifactId?: string
  audioArtifactId?: string
  onNext: () => void
  onPrev: () => void
  onOpenSettings?: () => void
}) {
  const [assets, setAssets] = useState<AvatarAsset[]>([])
  const [assetsStatus, setAssetsStatus] = useState<AssetsStatus>('loading')
  const [assetError, setAssetError] = useState<string>()
  const [selectedAssetId, setSelectedAssetId] = useState<string>()
  const [dismissedArtifactId, setDismissedArtifactId] = useState<string>()
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('idle')
  const [previewError, setPreviewError] = useState<string>()
  const [assetMutation, setAssetMutation] = useState<'uploading' | string>()
  const [generationPending, setGenerationPending] = useState(false)
  const [invalidAvatarPreviewId, setInvalidAvatarPreviewId] = useState<string>()
  const assetsRequestRef = useRef(0)
  const interactionLockRef = useRef(false)
  const avatarUpload = useAvatarAssetUpload(projectId)
  const heygem = useHeyGem(projectId)
  const runtimeGate = useDigitalHumanRuntime()

  const readyAssets = assets.filter((asset) => asset.status === 'ready')
  const selectedAsset = readyAssets.find((asset) => asset.assetId === selectedAssetId)
  const selectedPreviewUrl = selectedAsset
    ? avatarAssetFileEndpoint(projectId, selectedAsset.assetId)
    : undefined
  const verifiedArtifactId = heygem.status === 'done' ? heygem.artifact?.artifactId : undefined
  const verifiedPreviewUrl = verifiedArtifactId && verifiedArtifactId !== dismissedArtifactId
    ? renderArtifactFileEndpoint(projectId, verifiedArtifactId)
    : undefined
  const completedPreviewUrl = previewStatus === 'failed' ? undefined : verifiedPreviewUrl
  const isDone = Boolean(completedPreviewUrl && previewStatus === 'ready')
  const missingInput = !scriptArtifactId
    ? '请先在文案页生成并确认文案。'
    : !audioArtifactId
      ? '请先在声音页生成音频。'
      : ''
  const runtimeLocked = heygem.status === 'recovering'
    || heygem.status === 'running'
    || runtimeGate.preparing
    || generationPending
  const interactionLocked = runtimeLocked
    || avatarUpload.status === 'uploading'
    || assetMutation !== undefined
  const canGenerate = Boolean(
    selectedAsset
      && selectedAsset.assetId !== invalidAvatarPreviewId
      && !missingInput
      && runtimeGate.canGenerate
      && !interactionLocked,
  )

  const refreshAssets = useCallback(async () => {
    const requestId = ++assetsRequestRef.current
    setAssetsStatus('loading')
    setAssetError(undefined)
    const result = await listAvatarAssetsClient(projectId)
    if (assetsRequestRef.current !== requestId) return
    if (result.status !== 'ok' || !('assets' in result)) {
      setAssets([])
      setSelectedAssetId(undefined)
      setAssetsStatus('failed')
      setAssetError(result.status === 'ok' ? '形象素材列表响应无效。' : result.error.message)
      return
    }
    const nextAssets = result.assets.filter((asset) => asset.status === 'ready')
    setAssets(nextAssets)
    setAssetsStatus('ready')
    setAssetError(undefined)
    setSelectedAssetId((current) => {
      if (current && nextAssets.some((asset) => asset.assetId === current)) return current
      return nextAssets[0]?.assetId
    })
  }, [projectId])

  useEffect(() => {
    setAssets([])
    setSelectedAssetId(undefined)
    setDismissedArtifactId(undefined)
    setPreviewStatus('idle')
    setPreviewError(undefined)
    setInvalidAvatarPreviewId(undefined)
    void refreshAssets()
    return () => {
      assetsRequestRef.current += 1
    }
  }, [refreshAssets])

  useEffect(() => {
    setPreviewStatus(verifiedPreviewUrl ? 'loading' : 'idle')
    setPreviewError(undefined)
  }, [verifiedPreviewUrl])

  async function uploadAvatar(file: File | undefined) {
    if (!file || interactionLocked || interactionLockRef.current) return
    interactionLockRef.current = true
    setAssetMutation('uploading')
    try {
      const result = await avatarUpload.upload({ file })
      if (result.status !== 'ok') return
      setSelectedAssetId(result.asset.assetId)
      setDismissedArtifactId(verifiedArtifactId)
      setPreviewStatus('idle')
      setPreviewError(undefined)
      await refreshAssets()
    } finally {
      interactionLockRef.current = false
      setAssetMutation(undefined)
    }
  }

  async function deleteAsset(assetId: string) {
    if (interactionLocked || interactionLockRef.current) return
    interactionLockRef.current = true
    setAssetMutation(assetId)
    try {
      const result = await deleteAvatarAssetClient(projectId, assetId)
      if (result.status !== 'ok') {
        setAssetError(result.error.message)
        return
      }
      if (assetId === selectedAssetId) setSelectedAssetId(undefined)
      setDismissedArtifactId(verifiedArtifactId)
      setPreviewStatus('idle')
      setPreviewError(undefined)
      await refreshAssets()
    } finally {
      interactionLockRef.current = false
      setAssetMutation(undefined)
    }
  }

  async function generate() {
    if (!canGenerate || interactionLockRef.current || !selectedAsset) return
    interactionLockRef.current = true
    setGenerationPending(true)
    setDismissedArtifactId(verifiedArtifactId)
    setPreviewStatus('idle')
    setPreviewError(undefined)
    try {
      const runtime = await runtimeGate.ensureReady()
      if (!runtime.ready) return
      await heygem.generate({
        sessionId: 'avatar-session',
        input: {
          avatarAssetId: selectedAsset.assetId,
          mode: 'standard',
        },
      })
    } finally {
      interactionLockRef.current = false
      setGenerationPending(false)
    }
  }

  function replaceAvatar() {
    if (interactionLocked) return
    setDismissedArtifactId(verifiedArtifactId)
    setPreviewStatus('idle')
    setPreviewError(undefined)
  }

  function captionText() {
    if (isDone) return '数字人已生成 · 口型与表情已就绪'
    if (previewStatus === 'failed') return previewError ?? '数字人视频无法读取，请重新生成。'
    if (verifiedPreviewUrl && previewStatus === 'loading') return '正在验证数字人视频预览…'
    if (heygem.status === 'recovering') return '正在恢复并核验上次数字人任务…'
    if (heygem.status === 'running') return '正在驱动口型与表情，请稍候…'
    if (missingInput) return missingInput
    if (runtimeGate.preparing) return runtimeGate.message ?? '正在准备数字人运行环境…'
    if (runtimeGate.message) return runtimeGate.message
    if (avatarUpload.status === 'uploading') return '正在导入形象视频…'
    if (avatarUpload.status === 'invalid_request' || avatarUpload.status === 'upload_error') {
      return avatarUpload.lastResult?.status !== 'ok'
        ? avatarUpload.lastResult?.error.message
        : '形象视频导入失败，请检查格式。'
    }
    if (heygem.status === 'adapter_error' || heygem.status === 'invalid_request') {
      return heygem.lastResult?.status !== 'ok'
        ? heygem.lastResult?.error.message
        : '数字人服务不可用，请检查运行环境设置。'
    }
    if (assetError) return assetError
    if (assetsStatus === 'loading') return '正在读取本地形象素材…'
    if (!selectedAsset) return '请导入一段正脸视频作为数字人形象。'
    return `已选择：${selectedAsset.originalFilename}`
  }

  return (
    <div
      aria-busy={interactionLocked || previewStatus === 'loading'}
      className="relative flex min-h-[calc(100dvh-84px)] w-full flex-col items-center justify-center overflow-hidden pt-2"
    >
      <div className="flow-action-dock">
        {verifiedPreviewUrl && previewStatus !== 'failed' ? (
          <>
            <PrimaryButton tone="ghost" onClick={replaceAvatar} disabled={interactionLocked}>
              更换形象
            </PrimaryButton>
            <PrimaryButton tone="ghost" onClick={onNext} disabled={!isDone} loading={previewStatus === 'loading'} className="flow-next-button">
              下一步
            </PrimaryButton>
          </>
        ) : (
          <PrimaryButton
            tone="ghost"
            onClick={() => void generate()}
            disabled={!canGenerate}
            loading={runtimeLocked}
            className="flow-next-button"
          >
            生成
          </PrimaryButton>
        )}
      </div>

      <div className="room-light relative flex w-full items-center justify-center">
        <div className="relative animate-float-slow">
          <div className="shadow-spatial relative aspect-[3/4] w-60 overflow-hidden rounded-[30px] bg-card ring-1 ring-line md:w-72">
            {completedPreviewUrl ? (
              <video
                aria-label="数字人生成视频预览"
                src={completedPreviewUrl}
                className="size-full bg-black object-cover"
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={() => {
                  setPreviewStatus('ready')
                  setPreviewError(undefined)
                }}
                onError={() => {
                  setPreviewStatus('failed')
                  setPreviewError('数字人视频已生成，但当前无法读取；请重新生成或检查本地文件。')
                }}
              />
            ) : selectedPreviewUrl ? (
              <video
                aria-label={`形象预览 ${selectedAsset?.originalFilename ?? ''}`}
                src={selectedPreviewUrl}
                className="size-full bg-black object-cover"
                controls
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={() => {
                  if (invalidAvatarPreviewId === selectedAsset?.assetId) setInvalidAvatarPreviewId(undefined)
                  setAssetError(undefined)
                }}
                onError={() => {
                  if (!selectedAsset) return
                  setInvalidAvatarPreviewId(selectedAsset.assetId)
                  setAssetError('所选形象视频无法读取，请重新导入或选择其他素材。')
                }}
              />
            ) : (
              <label className="glass flex size-full cursor-pointer flex-col items-center justify-center gap-2">
                <Upload className="size-7 text-cyan" strokeWidth={1.5} />
                <span className="px-4 text-center text-sm font-medium">导入正脸视频</span>
                <span className="text-[11px] text-sub">MP4 / MOV / WebM</span>
                <input
                  aria-label="上传数字人形象视频"
                  className="sr-only"
                  type="file"
                  disabled={interactionLocked}
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(event) => {
                    const input = event.currentTarget
                    void uploadAvatar(input.files?.[0]).finally(() => { input.value = '' })
                  }}
                />
              </label>
            )}

            {heygem.status === 'running' && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="pointer-events-none absolute inset-0 bg-cyan/10"
              >
                <div className="absolute inset-x-0 h-20 animate-pulse bg-gradient-to-b from-transparent via-cyan/40 to-transparent" />
              </motion.div>
            )}

            {selectedAsset && !completedPreviewUrl && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                <span className="block truncate text-xs font-medium text-white">{selectedAsset.originalFilename}</span>
              </div>
            )}
          </div>
          <div className="absolute -bottom-6 left-1/2 h-8 w-3/4 -translate-x-1/2 rounded-[50%] bg-black/10 blur-xl" />
        </div>
      </div>

      <div className="relative z-10 mt-6 flex w-full max-w-xl flex-col items-center gap-3 px-5">
        <p
          aria-live="polite"
          role={previewStatus === 'failed' || heygem.status === 'adapter_error' || heygem.status === 'invalid_request' || assetsStatus === 'failed' || assetError ? 'alert' : 'status'}
          className="min-h-5 text-center text-[13px] text-sub"
        >
          {captionText()}
        </p>
        {runtimeGate.action === 'open_settings' && (
          <button
            type="button"
            className="rounded-full border border-line px-3 py-1.5 text-xs text-sub transition-colors hover:border-cyan/50 hover:text-foreground"
            onClick={onOpenSettings}
          >
            打开运行环境设置
          </button>
        )}

        {!isDone && (
          <div className="flex w-full flex-col gap-2 rounded-2xl border border-line/70 bg-card/70 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Video className="size-4 text-cyan" />
                本地形象
                <span className="font-mono text-[11px] text-sub">{readyAssets.length}</span>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs text-sub transition-colors hover:border-cyan/50 hover:text-foreground">
                <Upload className="size-3.5" />
                导入视频
                <input
                  aria-label="更换数字人形象视频"
                  className="sr-only"
                  type="file"
                  disabled={interactionLocked}
                  accept="video/mp4,video/quicktime,video/webm"
                  onChange={(event) => {
                    const input = event.currentTarget
                    void uploadAvatar(input.files?.[0]).finally(() => { input.value = '' })
                  }}
                />
              </label>
            </div>

            {readyAssets.length > 0 ? (
              <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                {readyAssets.map((asset) => {
                  const selected = asset.assetId === selectedAssetId
                  return (
                    <div
                      key={asset.assetId}
                      className={`flex items-center gap-2 rounded-xl px-2 py-2 ${selected ? 'bg-cyan/10 ring-1 ring-cyan/30' : 'hover:bg-secondary/60'}`}
                    >
                      <button
                        type="button"
                        aria-pressed={selected}
                        disabled={interactionLocked}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => {
                          if (interactionLocked || interactionLockRef.current) return
                          setSelectedAssetId(asset.assetId)
                          setAssetError(undefined)
                          setDismissedArtifactId(verifiedArtifactId)
                          setPreviewStatus('idle')
                          setPreviewError(undefined)
                        }}
                      >
                        <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-cyan text-background' : 'border border-line'}`}>
                          {selected && <Check className="size-3" strokeWidth={3} />}
                        </span>
                        <span className="truncate text-xs">{asset.originalFilename}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`删除形象 ${asset.originalFilename}`}
                        disabled={interactionLocked}
                        className="rounded-full p-1.5 text-sub hover:bg-red-500/10 hover:text-red-500"
                        onClick={() => void deleteAsset(asset.assetId)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : assetsStatus === 'ready' ? (
              <p className="py-2 text-center text-xs text-sub">暂无本地形象，导入后即可复用。</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
