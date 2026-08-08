'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  AlertTriangle,
  Check,
  GitBranch,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import type { DesktopRuntimeNotice } from '@/lib/desktop-runtime/desktop-runtime-notice'
import type { RuntimeReadinessNotice } from '@/lib/runtime-readiness/runtime-readiness-notice'
import { useAgentSessionTimeline } from '@/lib/agents/use-agent-session-timeline'
import type { AgentSessionTimelineItem } from '@/lib/agents/agent-session-timeline-client'
import { cn } from '@/lib/utils'

const roleLabel: Record<string, string> = {
  script: '文案',
  voice: '声音',
  digital_human: '数字人',
  post_production: '剪辑',
  publish: '发布准备',
  reviewer: '检查',
}

const artifactLabel: Record<string, string> = {
  script: '文案已保存',
  audio: '音频已生成',
  render: '数字人视频已生成',
  'post-production': '成片已导出',
  'publish-package': '发布包已准备',
}

export function FlowStatusPopover({
  projectId,
  runtimeNotices,
  activeRuntimeNotice,
  isDesktopShell,
  onOpenSettings,
}: {
  projectId: string
  runtimeNotices: DesktopRuntimeNotice[]
  activeRuntimeNotice?: RuntimeReadinessNotice
  isDesktopShell: boolean
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const timeline = useAgentSessionTimeline(projectId)
  const items = timeline.result?.status === 'ok' ? timeline.result.items : []
  const timelineError = timeline.result && timeline.result.status !== 'ok' ? timeline.result.error : undefined
  const notices = useMemo(
    () => [
      ...runtimeNotices,
      ...(activeRuntimeNotice ? [activeRuntimeNotice] : []),
    ],
    [activeRuntimeNotice, runtimeNotices],
  )
  const hasError = notices.some((notice) => notice.tone === 'error') || Boolean(timelineError)
  const state = timeline.loading ? 'checking' : hasError ? 'error' : notices.length > 0 ? 'warning' : 'ready'

  useEffect(() => {
    if (!open) return
    function closeOnOutsidePress(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className={cn('fixed left-3 z-40', isDesktopShell ? 'top-12' : 'top-14')}
    >
      <button
        type="button"
        aria-label={`创作状态：${stateLabel(state)}`}
        aria-expanded={open}
        aria-controls="flow-status-popover"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'relative grid size-9 place-items-center rounded-full border bg-background/92 text-sub shadow-[0_8px_28px_-18px_rgba(15,23,42,0.55)] backdrop-blur-xl transition-[border-color,color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/45',
          hasError ? 'border-warning/55' : notices.length > 0 ? 'border-cyan/35' : 'border-line/80',
        )}
      >
        <GitBranch className="size-4" strokeWidth={1.8} />
        <motion.span
          aria-hidden="true"
          className={cn(
            'absolute right-0 top-0 size-2.5 rounded-full border-2 border-background',
            state === 'ready' && 'bg-[#20a36a]',
            state === 'checking' && 'bg-cyan',
            state === 'warning' && 'bg-[#d49324]',
            state === 'error' && 'bg-[#d24b4b]',
          )}
          animate={
            reduceMotion
              ? undefined
              : state === 'checking'
                ? { rotate: 360, scale: [0.82, 1, 0.82] }
                : { scale: [0.86, 1.08, 0.86], opacity: [0.72, 1, 0.72] }
          }
          transition={{ duration: state === 'checking' ? 1.1 : 2.4, repeat: Infinity, ease: 'linear' }}
        />
        {notices.length > 0 && (
          <span className="sr-only">{notices.length} 条环境提示</span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.section
            id="flow-status-popover"
            role="dialog"
            aria-label="创作状态详情"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: reduceMotion ? 0.01 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-line/80 bg-background/96 shadow-[0_24px_70px_-34px_rgba(15,23,42,0.42)] backdrop-blur-2xl"
          >
            <div className="flex items-center gap-2 border-b border-line/60 px-3.5 py-3">
              <span className="grid size-7 place-items-center rounded-full bg-secondary text-foreground">
                <Sparkles className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[13px] font-semibold text-foreground">创作状态</h2>
                <p className="text-[11px] text-sub">{stateLabel(state)}</p>
              </div>
              <button
                type="button"
                onClick={() => void timeline.refresh(projectId)}
                disabled={timeline.loading}
                aria-label="刷新创作状态"
                className="grid size-8 place-items-center rounded-full text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn('size-3.5', timeline.loading && 'animate-spin motion-reduce:animate-none')} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭创作状态"
                className="grid size-8 place-items-center rounded-full text-sub transition-colors hover:bg-secondary hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>

            <div className="max-h-[min(68dvh,32rem)] overflow-y-auto px-3.5 py-3">
              <StatusSection title="生产链路" icon={<GitBranch className="size-3.5" />}>
                {timelineError ? (
                  <StatusMessage tone="error" title="链路读取失败" message={timelineError.message} />
                ) : items.length === 0 ? (
                  <p className="py-1 text-xs leading-5 text-sub">从文案开始，声音、数字人和成片会自动串联到这里。</p>
                ) : (
                  <ol className="space-y-1">
                    {items.map((item) => <TimelineRow key={item.session.sessionId} item={item} />)}
                  </ol>
                )}
              </StatusSection>

              <div className="my-3 h-px bg-line/60" />

              <StatusSection title="环境检查" icon={<Settings2 className="size-3.5" />}>
                {notices.length === 0 ? (
                  <div className="flex items-center gap-2 py-1 text-xs text-sub">
                    <span className="grid size-5 place-items-center rounded-full bg-[#20a36a]/10 text-[#168255]">
                      <Check className="size-3" />
                    </span>
                    当前页面所需环境已就绪
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {notices.map((notice) => (
                      <StatusMessage
                        key={notice.id}
                        tone={notice.tone}
                        title={notice.title}
                        message={'action' in notice ? `${notice.message} ${notice.action}` : notice.message}
                      />
                    ))}
                    {activeRuntimeNotice && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false)
                          onOpenSettings()
                        }}
                        className="mt-1 inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                      >
                        <Settings2 className="size-3.5" />
                        {activeRuntimeNotice.actionLabel}
                      </button>
                    )}
                  </div>
                )}
              </StatusSection>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}

function StatusSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground/75">
        {icon}
        {title}
      </div>
      {children}
    </section>
  )
}

function TimelineRow({ item }: { item: AgentSessionTimelineItem }) {
  const artifact = item.artifactRecord
  const label = roleLabel[item.session.agentRole] ?? '创作步骤'
  const detail = artifact ? artifactLabel[artifact.artifactType] ?? '产物已保存' : '进度已记录'
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-secondary/60">
      <span className="size-1.5 shrink-0 rounded-full bg-cyan/75" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{label}</span>
      <span className="shrink-0 text-[11px] text-sub">{detail}</span>
    </li>
  )
}

function StatusMessage({ tone, title, message }: { tone: 'warning' | 'error'; title: string; message: string }) {
  return (
    <div className={cn('rounded-xl px-2.5 py-2', tone === 'error' ? 'bg-[#d24b4b]/8' : 'bg-[#d49324]/9')}>
      <div className="flex items-start gap-2">
        <AlertTriangle className={cn('mt-0.5 size-3.5 shrink-0', tone === 'error' ? 'text-[#bd3f3f]' : 'text-[#b67816]')} />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-4 text-sub">{message}</p>
        </div>
      </div>
    </div>
  )
}

function stateLabel(state: 'ready' | 'checking' | 'warning' | 'error') {
  if (state === 'checking') return '正在检查创作链路'
  if (state === 'error') return '有项目需要处理'
  if (state === 'warning') return '有环境提示'
  return '链路与环境正常'
}
