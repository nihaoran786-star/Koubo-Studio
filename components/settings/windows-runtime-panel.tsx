'use client'

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Download,
  RefreshCw,
  RotateCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWindowsRuntime } from '@/lib/windows-runtime/use-windows-runtime'
import type {
  WindowsRuntimeCheck,
  WindowsRuntimeCheckStatus,
  WindowsRuntimeGrade,
} from '@/lib/windows-runtime/windows-runtime-client'

export function WindowsRuntimePanel() {
  const runtime = useWindowsRuntime()
  const result = runtime.result

  return (
    <section
      aria-label="Windows 环境体检"
      aria-busy={runtime.loading || runtime.installing}
      className="border-b border-line/60 py-3"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary">
            <CircleGauge className="size-3.5 text-foreground" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Windows 数字人环境</h3>
              {result?.status === 'ok' && (
                <span className={cn('rounded-full px-2 py-0.5 text-[11px]', gradeTone(result.assessment.grade))}>
                  {result.assessment.label}
                </span>
              )}
            </div>
            <p aria-live="polite" className="mt-0.5 text-xs leading-relaxed text-sub">
              {runtime.loading && !result
                ? '正在检查 WSL、显卡与运行环境…'
                : result?.status === 'ok'
                  ? result.assessment.summary
                  : result?.error.message ?? '暂时无法读取 Windows 环境。'}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="刷新 Windows 环境体检"
          title="重新体检"
          onClick={runtime.refresh}
          disabled={runtime.loading || runtime.installing}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className={cn('size-3.5', runtime.loading && 'animate-spin')} />
        </button>
      </div>

      {result?.status === 'ok' && (
        <div className="mt-3 pl-9">
          {runtime.wslView.restartRequired && <RestartNotice />}

          {runtime.wslView.canInstall && (
            <div className="flex flex-col gap-2 border-y border-line/60 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium">需要安装 Windows WSL</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-sub">点击后 Windows 会弹出管理员授权；安装只需执行一次。</p>
              </div>
              <button
                type="button"
                onClick={runtime.installWsl}
                disabled={runtime.installing}
                aria-busy={runtime.installing}
                className="inline-flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-background disabled:opacity-40"
              >
                <Download className="size-3.5" />
                {runtime.installing ? '等待管理员授权并安装，请勿关闭' : '安装 WSL'}
              </button>
            </div>
          )}

          {runtime.wslView.needsManualRepair && (
            <div role="status" className="flex items-start gap-2 border-y border-line/60 py-2.5 text-xs leading-relaxed text-sub">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-cyan" />
              <span>WSL 尚未就绪，当前不能自动安装。需手动修复，请展开检查项查看下一步。</span>
            </div>
          )}

          {runtime.installResult?.status === 'ok' && (
            <p role="status" className="mt-2 text-xs leading-relaxed text-success">
              {runtime.installResult.message}
              {runtime.installResult.restartRequired ? ' 请重启 Windows 后再次体检。' : ''}
            </p>
          )}
          {runtime.installResult?.status === 'error' && (
            <p role="alert" className="mt-2 text-xs leading-relaxed text-danger">{runtime.installResult.error.message}</p>
          )}

          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-sub transition-colors hover:text-foreground">
              查看 {result.checks.length} 项检查结果
              <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
            </summary>
            <ul className="mt-2 grid gap-1.5">
              {result.checks.map((check) => <WindowsRuntimeCheckRow key={check.id} check={check} />)}
            </ul>
          </details>
        </div>
      )}
    </section>
  )
}

function RestartNotice() {
  return (
    <div className="mb-2 flex items-start gap-2 bg-cyan/8 px-2.5 py-2 text-xs text-cyan">
      <RotateCw className="mt-0.5 size-3.5 shrink-0" />
      <span>WSL 已安装，重启 Windows 后才能继续安装数字人运行环境。</span>
    </div>
  )
}

function WindowsRuntimeCheckRow({ check }: { check: WindowsRuntimeCheck }) {
  const Icon = check.status === 'ready' ? CheckCircle2 : AlertTriangle
  return (
    <li className="flex min-w-0 items-start gap-2 border-t border-line/50 pt-1.5 first:border-t-0 first:pt-0">
      <Icon className={cn('mt-0.5 size-3.5 shrink-0', checkTone(check.status))} />
      <div className="min-w-0 text-xs leading-relaxed">
        <span className="font-medium">{check.title}</span>
        <span className="ml-1.5 text-sub">{check.detail}</span>
        {check.action && <p className="text-[11px] text-sub">下一步：{check.action}</p>}
      </div>
    </li>
  )
}

function gradeTone(grade: WindowsRuntimeGrade) {
  if (grade === 'smooth') return 'bg-success/15 text-success'
  if (grade === 'usable') return 'bg-cyan/10 text-cyan'
  return 'bg-danger/10 text-danger'
}

function checkTone(status: WindowsRuntimeCheckStatus) {
  if (status === 'ready') return 'text-success'
  if (status === 'warning') return 'text-cyan'
  if (status === 'unknown') return 'text-sub'
  return 'text-danger'
}
