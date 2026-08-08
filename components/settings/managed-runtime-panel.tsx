'use client'

import { Box, CheckCircle2, FolderOpen, Power, RefreshCw, ShieldAlert, Square, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useManagedRuntime } from '@/lib/managed-runtime/use-managed-runtime'
import type { ManagedRuntimePhase } from '@/lib/managed-runtime/managed-runtime-client'
import { RuntimePackageDownloadBoundary } from './runtime-package-download-boundary'

const PHASE_LABELS: Record<ManagedRuntimePhase, string> = {
  absent: '未安装',
  stopped: '已停止',
  running: '启动中',
  ready: '可用',
  failed: '需修复',
}

export function ManagedRuntimePanel() {
  const managed = useManagedRuntime()
  const result = managed.result
  const runtime = result?.status === 'ok' ? result.runtime : undefined

  return (
    <section aria-label="数字人托管运行环境" className="border-b border-line/60 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary">
            <Box className="size-3.5 text-foreground" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">本地数字人运行包</h3>
              {runtime && (
                <span className={cn('rounded-full px-2 py-0.5 text-[11px]', phaseTone(runtime.phase))}>
                  {PHASE_LABELS[runtime.phase]}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-sub">
              {managed.loading && !result
                ? '正在检查 KouboRuntime…'
                : runtime?.detail
                  ?? (result?.status === 'error' ? result.error.message : '暂时无法读取数字人运行环境。')}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="刷新数字人运行环境"
          title="重新检查"
          onClick={managed.refresh}
          disabled={managed.loading || Boolean(managed.activeAction)}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn('size-3.5', managed.loading && 'animate-spin')} />
        </button>
      </div>

      {result?.status === 'ok' && !result.runtime.installed && (
        <div className="mt-3 ml-9 border-y border-line/60 py-2.5">
          <RuntimePackageDownloadBoundary packageId="koubo-runtime" label="数字人运行包" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium">导入已获授权的 KouboRuntime 包</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-sub">
                选择 X.tar 时，同一目录必须有 X.tar.sha256；文件不会上传，也不会安装 Docker。
                导入前会校验 SHA-256、包清单和固定启动入口。
              </p>
            </div>
            <button
              type="button"
              onClick={managed.importPackage}
              disabled={!result.actions.canImport || managed.importing}
              className="inline-flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-background disabled:opacity-40"
            >
              <FolderOpen className="size-3.5" />
              {managed.importing ? '正在验证并导入…' : '选择本地运行包'}
            </button>
          </div>
          <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-sub">
            <ShieldAlert className="mt-0.5 size-3 shrink-0" />
            <span>SHA-256 只能检查文件完整性，不代表数字签名或分发授权；请只选择你有权使用和分发的运行包。</span>
          </div>
        </div>
      )}

      {result?.status === 'ok' && result.runtime.installed && (result.actions.canStart || result.actions.canStop || result.actions.canUninstall) && (
        <div className="mt-3 ml-9 border-y border-line/60 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
          {result.actions.canStart && (
            <button
              type="button"
              onClick={managed.startRuntime}
              disabled={Boolean(managed.activeAction)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-background disabled:opacity-40"
            >
              <Power className="size-3.5" />
              {managed.activeAction === 'start' ? '正在启动…' : '启动运行环境'}
            </button>
          )}
          {result.actions.canStop && (
            <button
              type="button"
              onClick={managed.stopRuntime}
              disabled={Boolean(managed.activeAction)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line/70 px-3 text-xs font-medium disabled:opacity-40"
            >
              <Square className="size-3.5" />
              {managed.activeAction === 'stop' ? '正在停止…' : '停止运行环境'}
            </button>
          )}
          {result.actions.canUninstall && (
            <button
              type="button"
              onClick={managed.uninstallRuntime}
              disabled={Boolean(managed.activeAction)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-danger/30 px-3 text-xs font-medium text-danger disabled:opacity-40"
            >
              <Trash2 className="size-3.5" />
              {managed.activeAction === 'uninstall' ? '正在移除…' : '移除运行环境'}
            </button>
          )}
          </div>
          {result.actions.canUninstall && (
            <p className="mt-2 text-[11px] leading-relaxed text-sub">
              仅移除 KouboRuntime 及其内部模型；不会删除创作项目、素材或其他 WSL 发行版。移除后可重新导入修复。
            </p>
          )}
        </div>
      )}

      {managed.actionResult?.status === 'ok' && (
        <div role="status" className="mt-2 ml-9 text-xs text-success">
          <p className="flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5" />
            {managed.actionResult.message}
          </p>
          {managed.actionResult.sha256 && (
            <p className="mt-1 font-mono text-[11px] text-sub">
              SHA-256 {shortDigest(managed.actionResult.sha256)}
            </p>
          )}
        </div>
      )}
      {managed.actionResult?.status === 'error' && (
        <p role="alert" className="mt-2 ml-9 text-xs leading-relaxed text-danger">
          {managed.actionResult.error.message}
        </p>
      )}
    </section>
  )
}

function shortDigest(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

function phaseTone(phase: ManagedRuntimePhase) {
  if (phase === 'ready') return 'bg-success/15 text-success'
  if (phase === 'running' || phase === 'stopped') return 'bg-cyan/10 text-cyan'
  if (phase === 'failed') return 'bg-danger/10 text-danger'
  return 'bg-secondary text-sub'
}
