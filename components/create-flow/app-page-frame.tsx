import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function AppPageFrame({
  children,
  className,
  compact = false,
}: {
  children: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[1440px] flex-col px-4 md:px-8 xl:px-12',
        compact ? 'gap-3 pb-8 pt-3' : 'gap-5 pb-20 pt-5 md:pb-14 md:pt-6',
        className,
      )}
    >
      {children}
    </div>
  )
}
