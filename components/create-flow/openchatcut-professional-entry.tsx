'use client'

import { useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, Scissors } from 'lucide-react'
import {
  getOpenChatCutProjectClient,
  mutateOpenChatCutProjectClient,
  mutateOpenChatCutRuntimeClient,
} from '@/lib/openchatcut/client'
import type { OpenChatCutProjectBridge } from '@/lib/openchatcut/types'

export function OpenChatCutProfessionalEntry({
  projectId,
  videoReady,
}: {
  projectId: string
  videoReady: boolean
}) {
  const [bridge, setBridge] = useState<OpenChatCutProjectBridge>()
  const [busy, setBusy] = useState(false)
  const [request, setRequest] = useState('突出开场重点，画面铺满，添加自然的镜头节奏')
  const [message, setMessage] = useState('适合多轨道、转场、调色和精细动效。')
  const requestEpoch = useRef(0)

  useEffect(() => {
    let active = true
    const epoch = ++requestEpoch.current
    setBusy(false)
    if (!videoReady) {
      setBridge(undefined)
      return () => { active = false }
    }
    void getOpenChatCutProjectClient(projectId).then((result) => {
      if (!active || requestEpoch.current !== epoch) return
      if (result.status === 'error') {
        setMessage(result.error.message)
      } else if (result.bridge) {
        setBridge(result.bridge)
        setMessage(result.bridge.instructions.join(' '))
      } else if (result.stale) {
        setBridge(undefined)
        setMessage(result.detail ?? '先前的专业剪辑项目已过期，请重新创建。')
      }
    })
    return () => {
      active = false
      if (requestEpoch.current === epoch) requestEpoch.current += 1
    }
  }, [projectId, videoReady])

  useEffect(() => {
    if (!videoReady || bridge?.phase !== 'exporting') return
    let active = true
    let inFlight = false
    const poll = async () => {
      if (!active || inFlight) return
      inFlight = true
      const epoch = ++requestEpoch.current
      try {
        const result = await getOpenChatCutProjectClient(projectId)
        if (!active || requestEpoch.current !== epoch) return
        applyProjectResult(result)
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => { void poll() }, 1_750)
    void poll()
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [bridge?.phase, projectId, videoReady])

  function applyProjectResult(result: Awaited<ReturnType<typeof getOpenChatCutProjectClient>>) {
    if (result.status === 'error') {
      setMessage(result.error.message)
    } else if (result.bridge) {
      setBridge(result.bridge)
      setMessage(result.bridge.instructions.join(' '))
    } else if (result.stale) {
      setBridge(undefined)
      setMessage(result.detail ?? '先前的专业剪辑项目已过期，请重新创建。')
    }
  }

  async function refreshExportStatus() {
    const epoch = ++requestEpoch.current
    const result = await getOpenChatCutProjectClient(projectId)
    if (requestEpoch.current === epoch) applyProjectResult(result)
  }

  async function start() {
    const epoch = ++requestEpoch.current
    setBusy(true)
    try {
      const launched = await mutateOpenChatCutRuntimeClient({ action: 'launch', target: 'app' })
      if (requestEpoch.current !== epoch) return
      if (launched.status === 'error') {
        setMessage(launched.error.code === 'app_not_installed'
          ? '请先到设置安装 OpenChatCut。'
          : launched.error.message)
        return
      }
      const result = await mutateOpenChatCutProjectClient(projectId, { action: 'create' })
      if (requestEpoch.current !== epoch) return
      if (result.status === 'ok') {
        setBridge(result.bridge)
        setMessage(result.bridge.instructions.join(' '))
      } else {
        setMessage(result.error.message)
      }
    } finally {
      if (requestEpoch.current === epoch) setBusy(false)
    }
  }

  async function session(action: 'import' | 'begin' | 'status' | 'discard' | 'export') {
    if (!bridge) return
    const epoch = ++requestEpoch.current
    setBusy(true)
    try {
      const result = await mutateOpenChatCutProjectClient(projectId, {
        action,
        openChatCutProjectId: bridge.openChatCutProjectId,
        editSessionId: bridge.editSessionId,
        ...(action === 'begin' ? { request: request.trim() } : {}),
      })
      if (requestEpoch.current !== epoch) return
      if (result.status === 'ok') {
        setBridge(result.bridge)
        setMessage(result.bridge.instructions.join(' '))
      } else {
        setMessage(result.error.message)
      }
    } finally {
      if (requestEpoch.current === epoch) setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-y border-line/70 py-3">
      <span className="flex size-9 items-center justify-center rounded-full bg-cyan/10 text-cyan">
        <Scissors className="size-4" />
      </span>
      <div className="min-w-[220px] flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold">
          OpenChatCut 专业精剪
          {bridge && (
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-normal text-sub">
              {phaseLabel(bridge.phase)}
            </span>
          )}
        </div>
        <p role="status" className="mt-0.5 text-xs leading-relaxed text-sub">{message}</p>
      </div>
      {!bridge && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={!videoReady || busy}
          className="rounded-full bg-foreground px-4 py-2 text-xs font-medium text-background disabled:opacity-40"
        >
          {busy ? '正在连接…' : '进入专业精剪'}
        </button>
      )}
      {bridge && (
        <a
          href={bridge.editorUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-2 text-xs"
        >
          <ExternalLink className="size-3.5" />打开剪辑台
        </a>
      )}
      {bridge?.phase === 'needs_user_import' && (
        <div className="flex min-w-full flex-wrap items-end gap-2 pl-12">
          <button
            type="button"
            disabled={busy}
            onClick={() => void session('import')}
            className="rounded-full bg-foreground px-3 py-2 text-xs text-background disabled:opacity-40"
          >
            {busy ? '正在自动导入…' : '自动导入当前视频'}
          </button>
          <span className="text-[11px] text-sub">
            自动导入失败时，可在可见剪辑台手动导入；应用不会伪装导入成功。
          </span>
          <button
            type="button"
            disabled={busy || !request.trim()}
            onClick={() => void session('begin')}
            className="rounded-full border border-line px-3 py-2 text-xs disabled:opacity-40"
          >
            已手动导入，校验并生成草案
          </button>
        </div>
      )}
      {bridge?.phase === 'ready_to_draft' && (
        <div className="flex min-w-full flex-wrap items-end gap-2 pl-12">
          <label className="min-w-[260px] flex-1 text-[11px] text-sub">
            精剪要求
            <input
              aria-label="精剪要求"
              maxLength={400}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              className="mt-1 w-full rounded-xl border border-line bg-transparent px-3 py-2 text-xs text-foreground outline-none focus:border-cyan"
            />
          </label>
          <button
            type="button"
            disabled={busy || !request.trim()}
            onClick={() => void session('begin')}
            className="rounded-full bg-foreground px-3 py-2 text-xs text-background disabled:opacity-40"
          >
            {busy ? '正在生成…' : '生成 AI 草案'}
          </button>
        </div>
      )}
      {bridge?.phase === 'needs_review' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => void session('status')}
            className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-2 text-xs"
          >
            <RefreshCw className="size-3.5" />刷新审核状态
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void session('discard')}
            className="rounded-full px-3 py-2 text-xs text-sub"
          >
            放弃草案
          </button>
        </>
      )}
      {bridge?.phase === 'applied' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void session('export')}
          className="rounded-full bg-foreground px-3 py-2 text-xs text-background disabled:opacity-40"
        >
          {busy ? '正在导出并校验…' : '自动导出回项目'}
        </button>
      )}
      {bridge?.phase === 'exporting' && (
        <>
          <span className="text-xs text-sub">正在导出并校验成片，请保持 OpenChatCut 打开。</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refreshExportStatus()}
            className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-2 text-xs disabled:opacity-40"
          >
            <RefreshCw className="size-3.5" />刷新导出状态
          </button>
        </>
      )}
      {bridge?.phase === 'exported' && bridge.exportedVideoUrl && (
        <div className="min-w-full pl-12">
          <video
            aria-label="OpenChatCut 导出成片预览"
            controls
            preload="metadata"
            src={bridge.exportedVideoUrl}
            className="mt-2 max-h-72 w-full max-w-md rounded-2xl bg-black"
          />
        </div>
      )}
      {bridge && (bridge.phase === 'rejected' || bridge.phase === 'discarded') && (
        <button
          type="button"
          onClick={() => setBridge(undefined)}
          className="rounded-full border border-line px-3 py-2 text-xs"
        >
          重新创建
        </button>
      )}
    </div>
  )
}

function phaseLabel(phase: OpenChatCutProjectBridge['phase']) {
  return ({
    needs_user_import: '待导入',
    ready_to_draft: '可生成草案',
    drafting: '草案中',
    needs_review: '待审核',
    applied: '已应用·待导出',
    exporting: '导出中',
    exported: '已导回项目',
    rejected: '已拒绝',
    discarded: '已放弃',
  } as const)[phase]
}
