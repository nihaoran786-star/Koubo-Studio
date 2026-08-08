'use client'

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export function ChamberShell({
  code,
  title,
  statusPill,
  children,
  footer,
}: {
  code: string
  title: string
  subtitle?: string
  statusPill?: ReactNode
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <div className="relative flex min-h-[calc(100dvh-84px)] flex-col pb-2 pt-3">
      <div className="flow-action-dock">
        {footer}
      </div>
      {/* Middle: content */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
        className="flex min-h-[calc(100dvh-108px)] items-center justify-center py-2"
      >
        {children}
      </motion.div>
    </div>
  )
}

export function FooterBar({
  center,
}: {
  onPrev?: () => void
  onNext?: () => void
  prevLabel?: string
  nextLabel?: string
  center?: ReactNode
}) {
  return (
    <div className="flex items-center justify-center">
      {center}
    </div>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  loading,
  tone = 'cyan',
  className,
  ariaLabel,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  tone?: 'cyan' | 'dark' | 'ghost'
  className?: string
  ariaLabel?: string
}) {
  const isGhost = tone === 'ghost'
  return (
    <button
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'group relative inline-flex items-center justify-center transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40',
        isGhost
          ? 'gap-1 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-foreground/70 hover:text-foreground'
          : 'gap-2 overflow-hidden rounded-full px-7 py-3 text-sm font-semibold tracking-wide',
        tone === 'cyan' &&
          'bg-cyan text-background shadow-[0_8px_30px_-8px_var(--glow)] hover:shadow-[0_12px_44px_-6px_var(--glow)]',
        tone === 'dark' && 'bg-foreground text-background hover:opacity-90',
        className,
      )}
    >
      {loading && (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
      )}
      {children}
    </button>
  )
}
