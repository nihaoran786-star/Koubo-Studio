'use client'

import { useState } from 'react'
import { AlertTriangle, Plus, ArrowRight, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  type Project,
  type ProjectStatus,
} from '@/lib/projects'
import { ProjectCard } from './project-card'
import { AppPageFrame } from '@/components/create-flow/app-page-frame'

type Filter = 'all' | ProjectStatus

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'editing', label: '制作中' },
  { id: 'pending', label: '待发布' },
]

export function Dashboard({
  projects,
  ready,
  workspaceStatus = 'ready',
  workspaceError,
  onRetry,
  onCreate,
  onOpenProject,
  onViewAll,
  focus = 'overview',
}: {
  projects: Project[]
  ready: boolean
  workspaceStatus?: 'loading' | 'ready' | 'degraded' | 'error'
  workspaceError?: { code: string; message: string }
  onRetry?: () => void
  onCreate: () => void
  onOpenProject?: (p: Project) => void
  onViewAll?: () => void
  focus?: 'overview' | 'projects'
}) {
  const [filter, setFilter] = useState<Filter>('all')

  const filtered =
    filter === 'all' ? projects : projects.filter((p) => p.status === filter)

  const counts: Record<Filter, number> = {
    all: projects.length,
    draft: projects.filter((p) => p.status === 'draft').length,
    editing: projects.filter((p) => p.status === 'editing').length,
    pending: projects.filter((p) => p.status === 'pending').length,
    published: projects.filter((p) => p.status === 'published').length,
  }

  // On the overview, only preview a few projects; the full list lives in "作品".
  const isOverview = focus === 'overview'
  const visibleProjects = isOverview ? filtered.slice(0, 4) : filtered
  const hasProjects = projects.length > 0

  return (
    <AppPageFrame>
      {isOverview && (
        <section className="grid gap-8 border-b border-line/80 pb-10 pt-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="max-w-3xl">
            <span className="text-[13px] font-medium text-cyan">本地数字人口播</span>
            <h1 className="mt-3 text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.05em] md:text-[52px]">
              从一句想法，到可发布成片。
            </h1>
            <p className="mt-4 max-w-2xl text-[14px] leading-7 text-sub">
              生成文案、克隆声音、驱动数字人、本地剪辑，再准备抖音和小红书发布。
            </p>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className="group inline-flex h-12 items-center justify-center gap-3 rounded-full bg-foreground px-6 text-sm font-medium text-background transition-transform hover:-translate-y-0.5"
          >
            新建口播
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </button>
        </section>
      )}

      {!isOverview && (
        <header className="flex flex-col gap-1 border-b border-line/70 pb-4">
          <h1 className="text-balance text-[26px] font-semibold leading-tight tracking-[-0.035em] md:text-[32px]">
            项目生产队列
          </h1>
        </header>
      )}

      {!ready && <div className="border-b border-line/80 py-16 text-sm text-sub">正在读取本地项目…</div>}

      {ready && (workspaceStatus === 'degraded' || workspaceStatus === 'error') && (
        <section
          role="alert"
          className="flex flex-col gap-3 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-4 sm:flex-row sm:items-center"
        >
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {workspaceStatus === 'degraded' ? '部分项目未能读取' : '项目列表读取失败'}
            </p>
            <p className="mt-1 text-xs leading-5 text-sub">
              {workspaceError?.message ?? '请重新读取本地项目。'}
            </p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            <RotateCcw className="size-3.5" /> 重新读取
          </button>
        </section>
      )}

      {ready && workspaceStatus === 'ready' && !hasProjects && (
        <section className="grid min-h-56 place-items-center border-b border-line/80 py-12 text-center">
          <div>
            <p className="text-base font-medium">还没有口播项目</p>
            <p className="mt-2 text-sm text-sub">从文案开始，完成后会在这里继续和管理。</p>
            <button
              type="button"
              onClick={onCreate}
              className="mt-5 inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-medium hover:border-foreground/40"
            >
              <Plus className="size-4" /> 创建第一个项目
            </button>
          </div>
        </section>
      )}

      {ready && hasProjects && (
        <section className="flex flex-col gap-4 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {isOverview ? '生产队列' : '全部项目'}
            </h2>
            {isOverview ? (
              <button
                onClick={() => onViewAll?.()}
                className="text-sm font-medium text-cyan transition-opacity hover:opacity-70"
              >
                查看全部 {counts.all} 个
              </button>
            ) : (
              <div className="hairline inline-flex rounded-full bg-[var(--panel-solid)] p-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all',
                      filter === f.id
                        ? 'bg-foreground text-background'
                        : 'text-sub hover:text-foreground',
                    )}
                  >
                    {f.label}
                    <span
                      className={cn(
                        'num text-[11px]',
                        filter === f.id ? 'opacity-60' : 'opacity-50',
                      )}
                    >
                      {counts[f.id]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="border-y border-line/80">
            {visibleProjects.map((p) => (
              <ProjectCard key={p.id} project={p} onOpen={onOpenProject} compact={isOverview || focus === 'projects'} />
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="panel flex flex-col items-center gap-3 rounded-3xl py-16 text-center">
              <p className="text-sm text-sub">这个分类下还没有作品</p>
              <button
                onClick={onCreate}
                className="inline-flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-sm font-medium text-background"
              >
                <Plus className="size-4" /> 新建作品
              </button>
            </div>
          )}
        </section>
      )}
    </AppPageFrame>
  )
}
