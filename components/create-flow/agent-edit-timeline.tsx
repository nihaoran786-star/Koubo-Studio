'use client'

import { Bot, Captions, Film, Music2, Sparkles, WandSparkles } from 'lucide-react'
import type { EditPlanV1 } from '@/lib/post-production/edit-plan'
import { REMOTION_EFFECT_REGISTRY } from '@/lib/post-production/remotion-effect-registry'
import { cn } from '@/lib/utils'

export function AgentEditTimeline({
  plan,
  durationSeconds,
  running,
}: {
  plan?: EditPlanV1
  durationSeconds?: number
  running: boolean
}) {
  const effectLabels = plan?.creative.effects.map((effectId) =>
    REMOTION_EFFECT_REGISTRY.find((effect) => effect.id === effectId)?.label ?? effectId,
  ) ?? []
  const duration = durationSeconds && durationSeconds > 0 ? durationSeconds : 0

  return (
    <section className="panel overflow-hidden rounded-3xl" aria-label="AI 剪辑时间轴">
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-cyan/10 text-cyan ring-1 ring-cyan/25">
            <Bot className="size-4" />
            {running ? <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-cyan" /> : null}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              AI 剪辑师
              <span className={cn(
                'rounded-full px-2 py-0.5 font-mono text-[10px]',
                running ? 'bg-cyan/10 text-cyan' : plan ? 'bg-success/10 text-success' : 'bg-muted text-sub',
              )}>
                {running ? '正在编排' : plan ? '时间轴已应用' : '等待指令'}
              </span>
            </div>
            <p className="truncate text-[11px] text-sub">
              {running
                ? '分析文案 · 选择 Remotion 动效 · 编排字幕和镜头'
                : effectLabels.length
                  ? `${plan?.creative.preset} · ${effectLabels.join(' · ')}`
                  : '告诉右侧 AI 你要的节奏和风格'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-sub">
          <WandSparkles className="size-3.5 text-cyan" />
          {duration ? `${duration.toFixed(1)}s` : '00:00'}
        </div>
      </div>

      <div className="grid grid-cols-[78px_minmax(0,1fr)] text-[10px]">
        <TrackLabel icon={Film} label="视频" />
        <TrackLane>
          <Clip tone="video" width="100%" label={plan?.creative.motion === 'none' ? '数字人口播' : `数字人口播 · ${plan?.creative.motion}`} />
        </TrackLane>

        <TrackLabel icon={Captions} label="字幕" />
        <TrackLane>
          {Array.from({ length: 5 }).map((_, index) => (
            <Clip
              key={index}
              tone="caption"
              width={`${14 + (index % 2) * 3}%`}
              label={index === 0 ? plan?.creative.captions ?? '字幕' : ''}
            />
          ))}
        </TrackLane>

        <TrackLabel icon={Sparkles} label="效果" />
        <TrackLane>
          {(effectLabels.length ? effectLabels : ['等待 AI 选择']).slice(0, 5).map((label, index) => (
            <Clip key={`${label}-${index}`} tone="effect" width={`${Math.max(13, 24 - index * 2)}%`} label={label} />
          ))}
        </TrackLane>

        <TrackLabel icon={Music2} label="声音" />
        <TrackLane>
          <div className="flex h-8 flex-1 items-center gap-[2px] overflow-hidden rounded-lg border border-line/80 bg-black/5 px-2">
            {Array.from({ length: 52 }).map((_, index) => (
              <span
                key={index}
                className="w-0.5 shrink-0 rounded-full bg-cyan/55"
                style={{ height: `${22 + ((index * 17) % 70)}%` }}
              />
            ))}
          </div>
        </TrackLane>
      </div>
    </section>
  )
}

function TrackLabel({ icon: Icon, label }: { icon: typeof Film; label: string }) {
  return (
    <div className="flex items-center gap-2 border-r border-t border-line px-3 text-sub">
      <Icon className="size-3.5" />
      {label}
    </div>
  )
}

function TrackLane({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 gap-1.5 border-t border-line bg-black/[0.025] p-2">{children}</div>
}

function Clip({
  tone,
  width,
  label,
}: {
  tone: 'video' | 'caption' | 'effect'
  width: string
  label: string
}) {
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 items-center overflow-hidden rounded-lg border px-2 font-medium',
        tone === 'video' && 'border-cyan/25 bg-cyan/10 text-cyan',
        tone === 'caption' && 'border-amber-400/25 bg-amber-300/10 text-amber-600',
        tone === 'effect' && 'border-violet-400/25 bg-violet-400/10 text-violet-500',
      )}
      style={{ width }}
      title={label}
    >
      <span className="truncate">{label}</span>
    </div>
  )
}
