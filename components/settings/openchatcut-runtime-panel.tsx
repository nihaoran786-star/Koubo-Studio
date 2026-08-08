'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, LoaderCircle, RefreshCw, Scissors } from 'lucide-react'
import { getOpenChatCutRuntimeClient, mutateOpenChatCutRuntimeClient } from '@/lib/openchatcut/client'
import type { OpenChatCutRuntimeStatus } from '@/lib/openchatcut/types'
import { cn } from '@/lib/utils'

export function OpenChatCutRuntimePanel() {
  const [runtime, setRuntime] = useState<OpenChatCutRuntimeStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const mountedRef = useRef(true)
  const requestEpochRef = useRef(0)
  const refreshInFlightRef = useRef<Promise<void> | undefined>(undefined)
  const mutationInFlightRef = useRef(false)

  const refresh = useCallback(() => {
    if (mutationInFlightRef.current) return Promise.resolve()
    if (refreshInFlightRef.current) return refreshInFlightRef.current
    const epoch = ++requestEpochRef.current
    const request = getOpenChatCutRuntimeClient()
      .then((result) => {
        if (!mountedRef.current || epoch !== requestEpochRef.current) return
        if (result.status === 'ok') {
          setRuntime(result.runtime)
          setError(undefined)
        } else {
          setError(result.error.message)
        }
      })
      .finally(() => {
        if (refreshInFlightRef.current === request) refreshInFlightRef.current = undefined
      })
    refreshInFlightRef.current = request
    return request
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestEpochRef.current += 1
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!runtime || !isTransientPhase(runtime.phase)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh()
      if (!cancelled) timer = setTimeout(() => void poll(), 750)
    }
    timer = setTimeout(() => void poll(), 750)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh, runtime?.phase])

  async function act(body: { action: 'prepare' } | { action: 'launch'; target: 'installer' | 'app' }) {
    if (mutationInFlightRef.current) return
    mutationInFlightRef.current = true
    const epoch = ++requestEpochRef.current
    setBusy(true)
    setError(undefined)
    try {
      const result = await mutateOpenChatCutRuntimeClient(body)
      if (!mountedRef.current || epoch !== requestEpochRef.current) return
      if (result.status === 'ok') setRuntime(result.runtime)
      else setError(result.error.message)
    } finally {
      mutationInFlightRef.current = false
      if (mountedRef.current && epoch === requestEpochRef.current) setBusy(false)
    }
  }

  const action = runtime?.phase === 'not_installed'
    ? { label: '下载', body: { action: 'prepare' as const }, icon: Download }
    : runtime?.phase === 'failed' && runtime.error?.code === 'install_incomplete' && runtime.installerReady
      ? { label: '修复安装', body: { action: 'launch' as const, target: 'installer' as const }, icon: ExternalLink }
    : runtime?.phase === 'failed' && runtime.error?.code === 'install_incomplete'
      ? { label: '重新下载', body: { action: 'prepare' as const }, icon: Download }
    : runtime?.phase === 'failed' && !runtime.installed && runtime.error?.code !== 'auth_error'
      ? { label: '重试下载', body: { action: 'prepare' as const }, icon: Download }
    : runtime?.phase === 'installer_ready'
      ? { label: '安装', body: { action: 'launch' as const, target: 'installer' as const }, icon: ExternalLink }
      : runtime?.phase === 'installed'
        ? { label: '启动', body: { action: 'launch' as const, target: 'app' as const }, icon: ExternalLink }
        : undefined
  const loading = busy || (runtime ? isTransientPhase(runtime.phase) : true)

  return (
    <section aria-label="OpenChatCut 专业剪辑" className="flex items-center gap-3 border-b border-line/70 py-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
        {loading
          ? <LoaderCircle aria-label="OpenChatCut 正在处理" className="size-4 animate-spin" />
          : <Scissors className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="text-sm font-semibold">OpenChatCut 专业剪辑</span><span className={cn('rounded-full px-2 py-0.5 text-[11px]', runtime?.mcpReady ? 'bg-success/15 text-success' : 'bg-secondary text-sub')}>{runtimeLabel(runtime)}</span></div>
        <p className="mt-0.5 text-xs text-sub">
          {error ?? runtimeDetail(runtime)}
        </p>
      </div>
      {action && <button type="button" disabled={loading} onClick={() => void act(action.body)} className="inline-flex items-center gap-1 rounded-full bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-40"><action.icon className="size-3.5" />{loading ? '处理中' : action.label}</button>}
      <button type="button" aria-label="刷新专业剪辑器" disabled={busy} onClick={() => void refresh()} className="rounded-full p-2 text-sub hover:bg-secondary"><RefreshCw className={cn('size-3.5', busy && 'animate-spin')} /></button>
    </section>
  )
}

function runtimeDetail(runtime?: OpenChatCutRuntimeStatus) {
  if (!runtime) return '正在检查…'
  if (runtime.phase !== 'downloading' || !runtime.download) return runtime.detail
  const progress = runtime.download
  const received = `${(progress.received / 1024 / 1024).toFixed(1)} MiB`
  const total = progress.total ? ` / ${(progress.total / 1024 / 1024).toFixed(1)} MiB` : ''
  const percent = progress.percent === undefined ? '' : `（${progress.percent}%）`
  return `${progress.stalled ? '下载暂时没有进展，正在等待网络恢复：' : '正在下载：'}${received}${total}${percent}`
}

function runtimeLabel(runtime?: OpenChatCutRuntimeStatus) {
  if (!runtime) return '检查中'
  return ({
    not_installed: '未安装',
    downloading: '下载中',
    installer_ready: '待安装',
    installing: '安装中',
    installed: '待启动',
    launching: '启动中',
    external_instance: '实例冲突',
    mcp_ready: '已就绪',
    failed: '失败',
  } as const)[runtime.phase]
}

function isTransientPhase(phase: OpenChatCutRuntimeStatus['phase']) {
  return phase === 'downloading' || phase === 'installing' || phase === 'launching'
}
