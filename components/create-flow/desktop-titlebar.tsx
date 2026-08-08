'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, Minus, Square, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { NavId } from '@/components/dashboard/top-nav'
import { CHAMBERS, type ChamberId } from '@/lib/chambers'

const INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-window-drag]'

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function currentWindow() {
  const mod = await import('@tauri-apps/api/window')
  return mod.getCurrentWindow()
}

export function shouldStartWindowDrag(target: EventTarget | null, button: number) {
  return button === 0 && target instanceof Element && !target.closest(INTERACTIVE_SELECTOR)
}

const TABS: { id: NavId; label: string }[] = [
  { id: 'overview', label: '生产' },
  { id: 'projects', label: '作品' },
  { id: 'settings', label: '设置' },
]

export function DesktopTitlebar({
  active,
  activeStep,
  furthestStep,
  isDashboard,
  onNavigate,
  onStepSelect,
  onBackToDashboard,
  onDetected,
}: {
  active: NavId
  activeStep: ChamberId
  furthestStep: number
  isDashboard: boolean
  onNavigate: (id: NavId) => void
  onStepSelect: (id: ChamberId) => void
  onBackToDashboard: () => void
  onDetected?: (detected: boolean) => void
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const detected = isTauriRuntime()
    setVisible(detected)
    onDetected?.(detected)
  }, [onDetected])

  if (!visible) return null

  const activeIndex = CHAMBERS.find((step) => step.id === activeStep)?.index ?? 0
  const progress = CHAMBERS.length > 1 ? (activeIndex / (CHAMBERS.length - 1)) * 100 : 0

  function startWindowDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!shouldStartWindowDrag(event.target, event.button)) return
    event.preventDefault()
    void currentWindow().then((windowHandle) => windowHandle.startDragging())
  }

  return (
    <div
      data-tauri-drag-region
      onPointerDown={startWindowDrag}
      className="relative flex h-10 shrink-0 select-none items-center justify-between border-b border-line/70 bg-background/95 pl-2 text-[12px] text-sub"
    >
      <div data-tauri-drag-region className="relative z-10 flex min-w-0 items-center gap-2">
        <span className="relative flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-foreground">
          <span className="size-1.5 rounded-full bg-cyan" />
        </span>
        <span data-tauri-drag-region className="truncate font-semibold text-foreground">
          口播智能体
        </span>
        {!isDashboard && (
          <button
            type="button"
            onClick={onBackToDashboard}
            className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-sub transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
            工作台
          </button>
        )}
      </div>

      <nav data-tauri-drag-region className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-0.5">
        {isDashboard ? (
          TABS.map((tab) => {
            const on = active === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onNavigate(tab.id)}
                className={cn(
                  'pointer-events-auto relative rounded-full px-3.5 py-1 text-[12px] font-medium transition-colors',
                  on ? 'text-background' : 'text-sub hover:text-foreground',
                )}
              >
                {on && (
                  <motion.span
                    layoutId="desktop-titlebar-nav"
                    className="absolute inset-0 rounded-full bg-foreground"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
                <span className="relative">{tab.label}</span>
              </button>
            )
          })
        ) : (
          <div className="pointer-events-auto relative flex w-[360px] max-w-[42vw] items-center justify-between pt-2">
            <div className="absolute left-3 right-3 top-1/2 h-px -translate-y-1/2 bg-line" />
            <motion.div
              className="absolute left-3 top-1/2 h-px -translate-y-1/2 bg-cyan"
              animate={{ width: `calc((100% - 1.5rem) * ${progress / 100})` }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            />
            {CHAMBERS.map((step) => {
              const on = activeStep === step.id
              const reached = step.index <= furthestStep
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => reached && onStepSelect(step.id)}
                  disabled={!reached}
                  className={cn(
                    'relative flex flex-col items-center gap-0.5 px-1 text-[10px] font-medium transition-colors',
                    on
                      ? 'text-foreground'
                      : reached
                        ? 'text-sub hover:text-foreground'
                        : 'cursor-not-allowed text-sub/35',
                  )}
                >
                  <span
                    className={cn(
                      'relative z-10 size-1.5 rounded-full bg-line-strong transition-all',
                      reached && 'bg-cyan/55',
                      on && 'size-2.5 bg-cyan shadow-[0_0_0_4px_rgba(30,167,255,0.12)]',
                    )}
                  />
                  <span className={cn('relative mt-1 hidden leading-none md:block', on && 'text-cyan')}>
                    {step.zh}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </nav>

      <div className="relative ml-auto flex h-full items-center">
        <button
          type="button"
          aria-label="最小化"
          className="flex h-10 w-10 items-center justify-center text-sub transition-colors hover:bg-secondary hover:text-foreground"
          onClick={async () => (await currentWindow()).minimize()}
        >
          <Minus className="size-3.5" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="最大化或还原"
          className="flex h-10 w-10 items-center justify-center text-sub transition-colors hover:bg-secondary hover:text-foreground"
          onClick={async () => (await currentWindow()).toggleMaximize()}
        >
          <Square className="size-3" strokeWidth={1.7} />
        </button>
        <button
          type="button"
          aria-label="关闭"
          className="flex h-10 w-10 items-center justify-center text-sub transition-colors hover:bg-[#e5484d] hover:text-white"
          onClick={async () => (await currentWindow()).close()}
        >
          <X className="size-3.5" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
