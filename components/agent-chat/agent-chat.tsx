'use client'

import { LoaderCircle, Send, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AgentChatMessageType = 'user' | 'assistant' | 'system' | 'tool' | 'skill'

export type AgentCallStatus = 'queued' | 'running' | 'done' | 'failed'

export interface AgentChatMessage {
  id: string
  type: AgentChatMessageType
  text: string
  title?: string
  status?: AgentCallStatus
}

export function AgentChat({
  messages,
  input,
  placeholder = '补充目标用户、语气或重点…',
  disabled = false,
  loading = false,
  onInputChange,
  onSend,
}: {
  messages: AgentChatMessage[]
  input: string
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  onInputChange: (value: string) => void
  onSend: (value: string) => void
}) {
  function submit() {
    const value = input.trim()
    if (disabled || !value) return
    onSend(value)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
        {messages.map((message) => (
          <AgentChatMessageView key={message.id} message={message} />
        ))}
        {loading && (
          <div
            role="status"
            aria-label="AI 正在处理"
            className="flex h-7 items-center px-1 text-cyan"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-end gap-2 rounded-[22px] border border-line bg-white/68 px-3 py-2 shadow-[0_8px_24px_-22px_rgba(17,24,39,0.28)] focus-within:border-cyan">
        <textarea
          value={input}
          rows={1}
          disabled={disabled}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
          className="max-h-24 min-h-6 w-full resize-none bg-transparent text-sm outline-none placeholder:text-sub/50 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || input.trim().length === 0}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0"
          aria-label="发送"
        >
          <Send className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function AgentChatMessageView({ message }: { message: AgentChatMessage }) {
  if (message.type === 'tool') {
    if (message.status !== 'queued' && message.status !== 'running') return null

    return (
      <div
        role="status"
        aria-label="AI 正在处理"
        className="flex h-7 items-center px-1 text-cyan"
      >
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      </div>
    )
  }

  if (message.type === 'skill') {
    return (
      <div className="rounded-[20px] border border-line/80 bg-white/72 px-3 py-2.5 text-sm shadow-[0_1px_0_rgba(17,24,39,0.03)]">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
            <Sparkles className="size-3.5 text-cyan" />
            <span className="truncate">{message.title ?? 'Skill 调用'}</span>
          </span>
          {message.status && (
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-sub">
              {statusLabel(message.status)}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-sub">{message.text}</p>
      </div>
    )
  }

  if (message.type === 'system') {
    return (
      <div className="mx-auto max-w-[92%] rounded-full bg-secondary px-3 py-1.5 text-center text-xs text-sub">
        {message.text}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'max-w-[92%] rounded-[22px] px-4 py-3 text-sm leading-relaxed shadow-[0_1px_0_rgba(17,24,39,0.03)]',
        message.type === 'user'
          ? 'ml-auto bg-accent text-accent-foreground ring-1 ring-cyan/10'
          : 'bg-white/78 text-foreground ring-1 ring-line/80',
      )}
    >
      {message.text}
    </div>
  )
}

function statusLabel(status: AgentCallStatus) {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '运行中'
  if (status === 'done') return '已完成'
  return '失败'
}
