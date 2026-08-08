import { cn } from '@/lib/utils'

type Tone = 'idle' | 'cyan' | 'teal' | 'success' | 'warning'

const toneMap: Record<Tone, { dot: string; text: string; ring: string }> = {
  idle: { dot: 'bg-sub', text: 'text-sub', ring: 'ring-line' },
  cyan: { dot: 'bg-cyan', text: 'text-[#0b6fa6]', ring: 'ring-cyan/30' },
  teal: { dot: 'bg-teal', text: 'text-[#067a73]', ring: 'ring-teal/30' },
  success: {
    dot: 'bg-success',
    text: 'text-[#1f8a62]',
    ring: 'ring-success/30',
  },
  warning: {
    dot: 'bg-warning',
    text: 'text-[#a9700e]',
    ring: 'ring-warning/30',
  },
}

export function StatusPill({
  label,
  tone = 'idle',
  pulse = false,
  className,
}: {
  label: string
  tone?: Tone
  pulse?: boolean
  className?: string
}) {
  const t = toneMap[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-medium tracking-wide ring-1 backdrop-blur',
        t.ring,
        t.text,
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {pulse && (
          <span
            className={cn(
              'absolute inline-flex size-full animate-ping rounded-full opacity-60',
              t.dot,
            )}
          />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full', t.dot)} />
      </span>
      {label}
    </span>
  )
}
