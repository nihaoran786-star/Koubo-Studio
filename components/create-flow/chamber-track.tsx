'use client'

import { motion } from 'framer-motion'
import { CHAMBERS, type ChamberId } from '@/lib/chambers'
import { cn } from '@/lib/utils'

export function ChamberTrack({
  active,
  furthest,
  onSelect,
}: {
  active: ChamberId
  furthest: number
  onSelect: (id: ChamberId) => void
}) {
  return (
    <nav
      aria-label="生成舱进度"
      className="glass mx-auto flex w-fit items-center gap-1 rounded-full p-1.5"
    >
      {CHAMBERS.map((c) => {
        const isActive = c.id === active
        const reached = c.index <= furthest
        return (
          <button
            key={c.id}
            onClick={() => reached && onSelect(c.id)}
            disabled={!reached}
            className={cn(
              'relative flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'text-foreground'
                : reached
                  ? 'text-sub hover:text-foreground'
                  : 'cursor-not-allowed text-sub/40',
            )}
          >
            {isActive && (
              <motion.span
                layoutId="track-active"
                className="absolute inset-0 rounded-full bg-white shadow-[0_2px_12px_-4px_var(--glow)] ring-1 ring-cyan/30"
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            )}
            <span
              className={cn(
                'relative size-1.5 rounded-full transition-colors',
                isActive
                  ? 'bg-cyan'
                  : reached
                    ? 'bg-success'
                    : 'bg-line',
              )}
            />
            <span className="relative hidden sm:inline">{c.zh}</span>
            <span className="relative font-mono text-[10px] tracking-wider sm:hidden">
              {c.code}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
