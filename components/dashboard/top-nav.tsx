'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'

export type NavId = 'overview' | 'projects' | 'settings' | 'create'

const TABS: { id: NavId; label: string }[] = [
  { id: 'overview', label: '生产' },
  { id: 'projects', label: '作品' },
  { id: 'settings', label: '设置' },
]

export function TopNav({
  active,
  onNavigate,
}: {
  active: NavId
  onNavigate: (id: NavId) => void
}) {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-line/70 bg-background/90 backdrop-blur-xl">
      <div className="relative mx-auto flex h-10 w-full max-w-[1240px] items-center px-4 md:px-8">
        {/* brand — left */}
        <button
          onClick={() => onNavigate('overview')}
          className="flex items-center gap-1.5"
          aria-label="口播智能体"
        >
          <span className="relative flex size-5 items-center justify-center">
            <span className="absolute inset-0 rounded-[6px] bg-foreground shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]" />
            <span className="relative size-1.5 rounded-full bg-cyan" />
          </span>
          <span className="text-[12px] font-semibold tracking-tight">口播智能体</span>
        </button>

        {/* center tabs — absolute centered */}
        <nav className="absolute inset-x-0 hidden items-center justify-center gap-0.5 md:flex">
          {TABS.map((t) => {
            const on = active === t.id
            return (
              <button
                key={t.id}
                onClick={() => onNavigate(t.id)}
                className={cn(
                  'relative rounded-full px-3.5 py-1 text-[12px] font-medium transition-colors',
                  on ? 'text-background' : 'text-sub hover:text-foreground',
                )}
              >
                {on && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-full bg-foreground text-background"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative">{t.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="ml-auto h-7 w-7" aria-hidden />
      </div>

      {/* mobile tabs */}
      <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-2 md:hidden">
        {TABS.map((t) => {
          const on = active === t.id
          return (
            <button
              key={t.id}
              onClick={() => onNavigate(t.id)}
              className={cn(
                'rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors',
                on ? 'bg-secondary text-foreground' : 'text-sub',
              )}
            >
              {t.label}
            </button>
          )
        })}
      </nav>
    </header>
  )
}
