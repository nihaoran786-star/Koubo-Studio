'use client'

import Image from 'next/image'
import { Heart, Eye, UserPlus, Clock, ArrowRight, Layers, Mic2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusPill } from '@/components/create-flow/status-pill'
import { type Project, STATUS_META } from '@/lib/projects'

const STEP_LABELS = ['文案', '声音', '数字人', '成片', '发布']

function fmt(n?: number) {
  if (n == null) return '-'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function ProjectCard({
  project,
  onOpen,
  compact = false,
}: {
  project: Project
  onOpen?: (p: Project) => void
  compact?: boolean
}) {
  const meta = STATUS_META[project.status]
  const inProgress = project.status === 'editing' || project.status === 'draft'
  const published = project.status === 'published'

  if (compact) {
    return (
      <button
        onClick={() => onOpen?.(project)}
        className="group grid w-full grid-cols-[64px_minmax(0,1fr)] gap-3 border-b border-line/80 py-3.5 text-left transition-colors last:border-b-0 hover:bg-white/55 md:grid-cols-[72px_minmax(0,1fr)_auto] md:gap-4"
      >
        <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-secondary">
          <ProjectCover project={project} compact />
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatusPill
              label={meta.zh}
              tone={meta.tone}
              pulse={project.status === 'editing'}
              className="bg-transparent px-0 py-0 ring-0"
            />
            <span className="text-xs text-sub">{project.updatedAt}</span>
            <span className="text-xs text-sub">·</span>
            <span className="inline-flex items-center gap-1 text-xs text-sub">
              <Clock className="size-3" /> {project.duration}
            </span>
          </div>

          <h3 className="truncate text-[15px] font-semibold leading-tight tracking-tight">
            {project.title}
          </h3>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sub">
            <span>{project.platforms.join(' / ')}</span>
            {inProgress && project.step != null && (
              <span className="inline-flex items-center gap-1">
                <Layers className="size-3" /> 进行至 {STEP_LABELS[project.step - 1]}
              </span>
            )}
            {published && (
              <>
                <span className="inline-flex items-center gap-1">
                  <Eye className="size-3" /> {fmt(project.views)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Heart className="size-3" /> {fmt(project.likes)}
                </span>
              </>
            )}
            {!published && (
              <span className="inline-flex items-center gap-1">
                <Mic2 className="size-3" /> 声音 / 字幕待确认
              </span>
            )}
          </div>
        </div>

        <div className="col-span-2 flex items-center justify-between border-t border-line/60 pt-3 text-xs text-sub md:col-span-1 md:border-t-0 md:pt-0">
          <span className="md:hidden">下一步</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 font-medium text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
            {inProgress ? '继续制作' : published ? '查看数据' : '准备发布'}
            <ArrowRight className="size-3" />
          </span>
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={() => onOpen?.(project)}
      className="panel group flex flex-col overflow-hidden rounded-2xl text-left transition-all hover:border-line-strong"
    >
      {/* cover */}
      <div className="relative aspect-video w-full overflow-hidden">
        <ProjectCover project={project} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
        <div className="absolute left-3 top-3">
          <StatusPill label={meta.zh} tone={meta.tone} pulse={project.status === 'editing'} />
        </div>
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
          <Clock className="size-3" /> {project.duration}
        </div>
      </div>

      {/* body */}
      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 text-pretty text-sm font-semibold leading-snug">
          {project.title}
        </h3>

        <div className="flex flex-wrap gap-1.5">
          {project.platforms.map((p) => (
            <span
              key={p}
              className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-sub"
            >
              {p}
            </span>
          ))}
        </div>

        {/* in-progress: step bar */}
        {inProgress && project.step != null && (
          <div className="mt-1 flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] text-sub">
              <span>进行至「{STEP_LABELS[project.step - 1]}」</span>
              <span className="font-mono">{project.step}/5</span>
            </div>
            <div className="flex gap-1">
              {STEP_LABELS.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1 flex-1 rounded-full',
                    i < project.step! ? 'bg-cyan' : 'bg-line',
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* published: stats */}
        {published && (
          <div className="mt-1 grid grid-cols-3 gap-2 border-t border-line/60 pt-3">
            <Stat icon={<Eye className="size-3.5" />} value={fmt(project.views)} label="播放" />
            <Stat icon={<Heart className="size-3.5" />} value={fmt(project.likes)} label="点赞" />
            <Stat
              icon={<UserPlus className="size-3.5" />}
              value={`+${fmt(project.newFans)}`}
              label="涨粉"
              accent
            />
          </div>
        )}

        <div className="mt-auto flex items-center justify-between pt-1 text-[11px] text-sub">
          <span>{project.updatedAt}</span>
          <span className="inline-flex items-center gap-1 font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {inProgress ? '继续制作' : published ? '查看数据' : '去发布'}
            <ArrowRight className="size-3" />
          </span>
        </div>
      </div>
    </button>
  )
}

function ProjectCover({ project, compact = false }: { project: Project; compact?: boolean }) {
  if (project.cover && project.coverMediaType === 'video') {
    return (
      <video
        aria-label={`${project.title} 的真实视频封面`}
        src={project.cover}
        muted
        playsInline
        preload="metadata"
        className={cn('size-full object-cover', !compact && 'transition-transform duration-500 group-hover:scale-105')}
      />
    )
  }

  return (
    <Image
      src={project.cover || '/project-cover-placeholder.svg'}
      alt={project.title}
      fill
      className={cn('object-cover', !compact && 'transition-transform duration-500 group-hover:scale-105')}
      sizes={compact ? '84px' : '(max-width: 768px) 100vw, 33vw'}
    />
  )
}

function Stat({
  icon,
  value,
  label,
  accent,
}: {
  icon: React.ReactNode
  value: string
  label: string
  accent?: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn('flex items-center gap-1 text-sub', accent && 'text-cyan')}>
        {icon}
      </span>
      <span className={cn('font-mono text-sm font-semibold tabular-nums', accent && 'text-cyan')}>
        {value}
      </span>
      <span className="text-[10px] text-sub">{label}</span>
    </div>
  )
}
