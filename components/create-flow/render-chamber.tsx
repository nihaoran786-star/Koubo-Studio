'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Volume2, Image as ImageIcon, Type, Music2, Film, Trash2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ChamberShell, FooterBar, PrimaryButton } from './chamber-shell'
import { StatusPill } from './status-pill'
import { AgentChat, type AgentChatMessage } from '@/components/agent-chat/agent-chat'
import { usePostProductionAgent } from '@/lib/post-production/use-post-production-agent'
import { createDefaultEditPlan } from '@/lib/post-production/edit-plan'
import { postProductionArtifactFileEndpoint } from '@/lib/post-production/post-production-agent-client'
import {
  deleteEditMediaAssetClient,
  editMediaAssetFileEndpoint,
  listEditMediaAssetsClient,
  uploadEditMediaAssetClient,
} from '@/lib/post-production/edit-media-asset-client'
import type { EditMediaAsset, EditMediaAssetKind } from '@/lib/post-production/edit-media-asset'
import { AgentEditTimeline } from './agent-edit-timeline'
import { OpenChatCutProfessionalEntry } from './openchatcut-professional-entry'

const RATIOS = [
  { id: '9:16', w: 9, h: 16 },
  { id: '1:1', w: 1, h: 1 },
  { id: '16:9', w: 16, h: 9 },
]

const SUBTITLES = [
  { id: 'clean', label: 'Aa', bg: 'bg-white text-black', name: '纯净' },
  { id: 'bold', label: 'Aa', bg: 'bg-black text-white', name: '醒目' },
  { id: 'cyan', label: 'Aa', bg: 'bg-cyan text-white', name: '高光' },
]

export function RenderChamber({
  projectId,
  renderArtifactId,
  postProductionArtifactId,
  onNext,
  onPrev,
  onPostProductionReady,
}: {
  projectId: string
  renderArtifactId?: string
  postProductionArtifactId?: string
  onNext: () => void
  onPrev: () => void
  onPostProductionReady?: (artifactId: string) => void
}) {
  const [ratio, setRatio] = useState('9:16')
  const [subtitle, setSubtitle] = useState('clean')
  const [voiceVolume, setVoiceVolume] = useState(1)
  const [coverTimestamp, setCoverTimestamp] = useState(0)
  const [editAssets, setEditAssets] = useState<EditMediaAsset[]>([])
  const [backgroundMusicId, setBackgroundMusicId] = useState<string>()
  const [backgroundMusicVolume, setBackgroundMusicVolume] = useState(0.16)
  const [introId, setIntroId] = useState<string>()
  const [outroId, setOutroId] = useState<string>()
  const [assetMessage, setAssetMessage] = useState<string>()
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<AgentChatMessage[]>([
    {
      id: 'system-ready',
      type: 'system',
      text: '简单剪辑和 AI 精剪共用受控 EditPlan，由本机 ffmpeg 执行。',
    },
  ])
  const postAgent = usePostProductionAgent(projectId)
  const completedArtifactId = postAgent.artifact?.artifactId
  const exporting = postAgent.status === 'running' || (postAgent.status === 'recovering' && Boolean(postAgent.task))
  const completed = postAgent.status === 'done' && Boolean(completedArtifactId) && previewStatus === 'ready'

  useEffect(() => {
    let active = true
    void listEditMediaAssetsClient(projectId).then((result) => {
      if (!active) return
      if (result.status === 'ok' && 'assets' in result) setEditAssets(result.assets)
      else if ('error' in result) setAssetMessage(result.error.message)
    })
    return () => { active = false }
  }, [projectId])

  useEffect(() => {
    setPreviewStatus(completedArtifactId ? 'loading' : 'idle')
  }, [completedArtifactId, projectId])

  useEffect(() => {
    if (!completed || !completedArtifactId) return
    onPostProductionReady?.(completedArtifactId)
  }, [completed, completedArtifactId, onPostProductionReady])

  async function exportVideo(mode: 'manual' | 'ai', request = input.trim() || '加字幕并整理成片') {
    const instruction = request || '加字幕并整理成片'
    if (!renderArtifactId) {
      setMessages((current) => [
        ...current,
        {
          id: `missing-render-${Date.now()}`,
          type: 'system',
          text: '请先在数字人阶段生成可用于后期的 render artifact。',
        },
      ])
      return
    }
    const skillMessageId = `skill-${Date.now()}`
    setMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        type: 'user',
        text: instruction,
      },
      {
        id: skillMessageId,
        type: 'skill',
        title: mode === 'ai' ? 'AI 精剪' : '本地剪辑',
        text: mode === 'ai' ? 'AI 正在生成受控剪辑计划…' : '正在校验 EditPlan 并调用本机 ffmpeg…',
        status: 'running',
      },
    ])
    setInput('')

    const result = await postAgent.run({
      sessionId: 'post-session',
      input: {
        renderArtifactId,
        request: instruction,
        mode,
        plan: {
          ...createDefaultEditPlan({
            ratio: ratio as '9:16' | '1:1' | '16:9',
            subtitleStyle: subtitle as 'clean' | 'bold' | 'cyan',
          }),
          audio: { voiceVolume },
          backgroundMusic: {
            enabled: Boolean(backgroundMusicId),
            ...(backgroundMusicId ? { assetId: backgroundMusicId } : {}),
            volume: backgroundMusicVolume,
          },
          intro: { enabled: Boolean(introId), ...(introId ? { assetId: introId } : {}) },
          outro: { enabled: Boolean(outroId), ...(outroId ? { assetId: outroId } : {}) },
          cover: { timestampSeconds: coverTimestamp },
        },
      },
    })
    const planning = result.status === 'ok' ? result.artifact.parameters?.aiPlanning : undefined
    const inputTokenText = planning?.reportedInputTokens ?? planning?.estimatedInputTokens
    const outputTokenText = planning?.reportedOutputTokens === undefined
      ? `输出上限 ${planning?.maxOutputTokens ?? 0}`
      : `实际输出 ${planning.reportedOutputTokens}`
    const successText = result.status === 'ok'
      ? planning?.source === 'cache'
        ? '已复用相同需求的 AI 剪辑计划，本次未调用云端模型。'
        : planning
          ? `AI 已完成一次低 Token 决策（输入 ${inputTokenText} Token，${outputTokenText} Token），本地剪辑已完成。`
          : `已生成后期成片 artifact：${result.artifact.artifactId}`
      : ''

    setMessages((current) =>
      current.map((message) =>
        message.id === skillMessageId
          ? {
              ...message,
              status: result.status === 'ok' ? 'done' : 'failed',
              text:
                result.status === 'ok'
                  ? successText
                  : result.error.message,
            }
          : message,
      ),
    )
    if (result.status === 'ok') setAssetMessage('成片已生成，正在核对项目状态和视频文件…')
  }

  function sendMessage(value: string) {
    void exportVideo('ai', value)
  }

  function updateInput(value: string) {
    setInput(value)
  }

  async function uploadEditAsset(kind: EditMediaAssetKind, file: File | undefined) {
    if (!file) return
    setAssetMessage('正在导入本地素材…')
    const result = await uploadEditMediaAssetClient({ projectId, kind, file })
    if (result.status !== 'ok' || !('asset' in result)) {
      setAssetMessage(result.error.message)
      return
    }
    setEditAssets((current) => [...current, result.asset])
    if (kind === 'background_music') setBackgroundMusicId(result.asset.assetId)
    if (kind === 'intro') setIntroId(result.asset.assetId)
    if (kind === 'outro') setOutroId(result.asset.assetId)
    setAssetMessage(`${result.asset.name} 已导入并选中。`)
  }

  async function removeEditAsset(asset: EditMediaAsset) {
    const result = await deleteEditMediaAssetClient(projectId, asset.assetId)
    if (result.status !== 'ok') {
      setAssetMessage(result.error.message)
      return
    }
    setEditAssets((current) => current.filter((item) => item.assetId !== asset.assetId))
    if (backgroundMusicId === asset.assetId) setBackgroundMusicId(undefined)
    if (introId === asset.assetId) setIntroId(undefined)
    if (outroId === asset.assetId) setOutroId(undefined)
    setAssetMessage(`${asset.name} 已删除。`)
  }

  return (
    <ChamberShell
      code="04 / Render"
      title="成片"
      subtitle="确认画面与样式，组装最终视频"
      statusPill={
        <StatusPill
          label={
            exporting ? '组装中' : completed ? '渲染完成' : postAgent.status === 'recovering' ? '检查成片' : '预览'
          }
          tone={completed ? 'success' : exporting ? 'cyan' : 'idle'}
          pulse={exporting || postAgent.status === 'recovering'}
        />
      }
      footer={
        <FooterBar
          center={
            completed ? (
              <PrimaryButton tone="ghost" onClick={onNext} className="flow-next-button">
                下一步
              </PrimaryButton>
            ) : (
              <PrimaryButton
                tone="ghost"
                onClick={() => void exportVideo('manual')}
                loading={exporting}
                disabled={!renderArtifactId || exporting || postAgent.status === 'recovering'}
                className="flow-next-button"
              >
                手动导出
              </PrimaryButton>
            )
          }
        />
      }
    >
      <div className="grid w-full max-w-[1180px] items-stretch gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* LEFT — big preview */}
        <div className="panel flex flex-col items-center justify-center gap-5 rounded-3xl p-6">
          <div className="relative w-64 shrink-0 overflow-hidden rounded-[30px] ring-1 ring-line md:w-72">
            <div className="relative aspect-[9/16]">
            {completedArtifactId ? (
              <video
                aria-label="最终成片预览"
                src={postProductionArtifactFileEndpoint(projectId, completedArtifactId)}
                controls
                onLoadedMetadata={() => setPreviewStatus('ready')}
                onError={() => {
                  setPreviewStatus('failed')
                  setAssetMessage('成片视频无法读取，请重新导出。')
                }}
                className="absolute inset-0 size-full object-contain bg-black"
              />
            ) : (
              <div className="absolute inset-0 bg-[linear-gradient(145deg,#13202a,#080b10)]" aria-label="等待生成成片" />
            )}
            {/* subtitle preview */}
            <div className="absolute bottom-14 inset-x-0 flex justify-center px-3">
              <span
                className={cn(
                  'rounded-md px-2 py-1 text-xs font-semibold',
                  SUBTITLES.find((s) => s.id === subtitle)!.bg,
                )}
              >
                让 AI 帮你组装成片
              </span>
            </div>

            {!exporting && !completedArtifactId && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-white/80 backdrop-blur">
                  <Play className="size-5 translate-x-0.5 text-foreground" fill="currentColor" />
                </span>
              </div>
            )}

            {/* layered assembly animation */}
            <AnimatePresence>
              {exporting && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white/55 backdrop-blur-sm"
                >
                  {['视频轨', '音频轨', '字幕层'].map((t, i) => (
                    <motion.div
                      key={t}
                      initial={{ x: -60, opacity: 0 }}
                      animate={{ x: 0, opacity: 1 }}
                      transition={{ delay: i * 0.3, repeat: Infinity, repeatType: 'reverse', duration: 1 }}
                      className="rounded-full bg-white px-3 py-1 text-[11px] font-medium text-cyan ring-1 ring-cyan/30"
                    >
                      {t}
                    </motion.div>
                  ))}
                  <span className="mt-1 font-mono text-[11px] text-sub">视频正在组装…</span>
                </motion.div>
              )}
            </AnimatePresence>
            </div>
          </div>

        </div>

        {/* RIGHT — controls */}
        <div className="flex flex-col gap-4">
          {/* ratio */}
          <div>
            <div className="mb-2 px-1 text-xs font-medium text-sub">画面比例</div>
            <div className="flex gap-2.5">
              {RATIOS.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRatio(r.id)}
                  className={cn(
                    'panel flex flex-1 flex-col items-center gap-1.5 rounded-2xl py-3.5 transition-all',
                    ratio === r.id && 'ring-2 ring-cyan',
                  )}
                >
                  <span className="flex h-5 w-5 items-center justify-center">
                    <span
                      className="rounded-[3px] border-2 border-foreground/70"
                      style={{
                        width: 20 * (r.w / Math.max(r.w, r.h)),
                        height: 20 * (r.h / Math.max(r.w, r.h)),
                      }}
                    />
                  </span>
                  <span className="font-mono text-[11px]">{r.id}</span>
                </button>
              ))}
            </div>
          </div>

          {/* subtitle style */}
          <div>
            <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-sub">
              <Type className="size-3.5" /> 字幕样式
            </div>
            <div className="flex gap-2.5">
              {SUBTITLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSubtitle(s.id)}
                  className={cn(
                    'panel flex flex-1 items-center justify-center gap-2 rounded-2xl py-3.5 transition-all',
                    subtitle === s.id && 'ring-2 ring-cyan',
                  )}
                >
                  <span className={cn('rounded px-2 py-0.5 text-xs font-bold', s.bg)}>
                    {s.label}
                  </span>
                  <span className="text-xs text-sub">{s.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* cover + volume */}
          <div>
            <div className="mb-2 px-1 text-xs font-medium text-sub">附加元素</div>
            <div className="flex gap-2.5">
              <label className="panel flex flex-1 items-center gap-2 rounded-2xl px-3 py-3 text-xs text-sub">
                <Volume2 className="size-4" />
                原声
                <input aria-label="原声音量" type="range" min="0" max="2" step="0.05" value={voiceVolume} onChange={(event) => setVoiceVolume(Number(event.target.value))} className="min-w-0 flex-1" />
                <span>{Math.round(voiceVolume * 100)}%</span>
              </label>
              <label className="panel flex flex-1 items-center gap-2 rounded-2xl px-3 py-3 text-xs text-sub">
                <ImageIcon className="size-4" /> 封面
                <input aria-label="封面时间点" type="number" min="0" step="0.1" value={coverTimestamp} onChange={(event) => setCoverTimestamp(Math.max(0, Number(event.target.value) || 0))} className="w-14 rounded bg-transparent text-right text-foreground outline-none" />
                秒
              </label>
            </div>
          </div>

          <div>
            <div className="mb-2 px-1 text-xs font-medium text-sub">本地素材</div>
            <div className="grid gap-2 sm:grid-cols-3">
              <EditAssetPicker
                label="背景音乐"
                kind="background_music"
                icon={Music2}
                assets={editAssets}
                selectedId={backgroundMusicId}
                onSelect={setBackgroundMusicId}
                onUpload={uploadEditAsset}
                onDelete={removeEditAsset}
                fileEndpoint={(assetId) => editMediaAssetFileEndpoint(projectId, assetId)}
              />
              <EditAssetPicker label="片头" kind="intro" icon={Film} assets={editAssets} selectedId={introId} onSelect={setIntroId} onUpload={uploadEditAsset} onDelete={removeEditAsset} fileEndpoint={(assetId) => editMediaAssetFileEndpoint(projectId, assetId)} />
              <EditAssetPicker label="片尾" kind="outro" icon={Film} assets={editAssets} selectedId={outroId} onSelect={setOutroId} onUpload={uploadEditAsset} onDelete={removeEditAsset} fileEndpoint={(assetId) => editMediaAssetFileEndpoint(projectId, assetId)} />
            </div>
            {backgroundMusicId && (
              <label className="mt-2 flex items-center gap-2 px-1 text-xs text-sub">
                BGM 音量
                <input aria-label="背景音乐音量" type="range" min="0" max="1" step="0.01" value={backgroundMusicVolume} onChange={(event) => setBackgroundMusicVolume(Number(event.target.value))} className="w-36" />
                {Math.round(backgroundMusicVolume * 100)}%
              </label>
            )}
            {assetMessage && <p className="mt-2 px-1 text-xs text-sub">{assetMessage}</p>}
          </div>

          <div className="panel flex min-h-[300px] flex-col rounded-3xl p-4">
            <AgentChat
              messages={messages}
              input={input}
              placeholder="告诉后期智能体要怎么剪，比如：加字幕并整理成片…"
              onInputChange={updateInput}
              onSend={sendMessage}
            />
          </div>
        </div>

        <div className="lg:col-span-2">
          <OpenChatCutProfessionalEntry projectId={projectId} videoReady={Boolean(renderArtifactId || completedArtifactId)} />
          <AgentEditTimeline
            plan={postAgent.artifact?.parameters?.plan}
            durationSeconds={postAgent.artifact?.durationSeconds}
            running={exporting}
          />
        </div>
      </div>
    </ChamberShell>
  )
}

function EditAssetPicker({
  label,
  kind,
  icon: Icon,
  assets,
  selectedId,
  onSelect,
  onUpload,
  onDelete,
  fileEndpoint,
}: {
  label: string
  kind: EditMediaAssetKind
  icon: typeof Music2
  assets: EditMediaAsset[]
  selectedId?: string
  onSelect: (assetId: string | undefined) => void
  onUpload: (kind: EditMediaAssetKind, file: File | undefined) => void
  onDelete: (asset: EditMediaAsset) => void
  fileEndpoint: (assetId: string) => string
}) {
  const matching = assets.filter((asset) => asset.kind === kind)
  const selected = matching.find((asset) => asset.assetId === selectedId)
  return (
    <div className="panel rounded-2xl p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-medium"><Icon className="size-3.5 text-cyan" />{label}</div>
      <select aria-label={`选择${label}`} value={selectedId ?? ''} onChange={(event) => onSelect(event.target.value || undefined)} className="w-full rounded-lg border border-line bg-transparent px-2 py-1.5 text-foreground">
        <option value="">不使用</option>
        {matching.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.name}</option>)}
      </select>
      {selected && kind === 'background_music' && <audio aria-label="试听背景音乐" controls preload="metadata" src={fileEndpoint(selected.assetId)} className="mt-2 h-7 w-full" />}
      {selected && kind !== 'background_music' && <video aria-label={`预览${label}`} controls muted preload="metadata" src={fileEndpoint(selected.assetId)} className="mt-2 aspect-video w-full rounded-lg bg-black object-contain" />}
      <div className="mt-2 flex items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1 text-sub hover:text-foreground">
          <Upload className="size-3" />导入
          <input aria-label={`导入${label}`} type="file" className="sr-only" accept={kind === 'background_music' ? '.mp3,.wav,.m4a,.aac,audio/*' : '.mp4,.mov,.webm,video/*'} onChange={(event) => void onUpload(kind, event.currentTarget.files?.[0])} />
        </label>
        {selected && <button type="button" aria-label={`删除${label}`} onClick={() => void onDelete(selected)} className="ml-auto inline-flex items-center gap-1 text-danger"><Trash2 className="size-3" />删除</button>}
      </div>
    </div>
  )
}
