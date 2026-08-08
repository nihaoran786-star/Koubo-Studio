'use client'

import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Cloud, Laptop, PlugZap, RefreshCw, Save, Server, type LucideIcon } from 'lucide-react'
import { AppPageFrame } from '@/components/create-flow/app-page-frame'
import {
  type EditableModelProvider,
  useModelProviderSettings,
} from '@/lib/model-providers/use-model-provider-settings'
import type { ModelProviderDataLocation, ModelProviderKind, ModelProviderStatus } from '@/lib/model-providers/model-provider-types'
import { useRuntimeReadiness } from '@/lib/runtime-readiness/use-runtime-readiness'
import type { RuntimeReadinessCheck, RuntimeReadinessCheckStatus } from '@/lib/runtime-readiness/runtime-readiness-types'
import type { LocalDuixAvatarRuntimeConfig, LocalIndexTTS2RuntimeConfig } from '@/lib/runtime-data/runtime-config-store'
import { cn } from '@/lib/utils'
import { createProjectStateClient } from '@/lib/project-state/project-state-client'
import { WindowsRuntimePanel } from './windows-runtime-panel'
import { ManagedRuntimePanel } from './managed-runtime-panel'
import { OpenChatCutRuntimePanel } from './openchatcut-runtime-panel'
import { RuntimePackageDownloadBoundary } from './runtime-package-download-boundary'

const KIND_ICON: Record<ModelProviderKind, LucideIcon> = {
  openai: Cloud,
  deepseek: Server,
  local_openai_compatible: Laptop,
  custom_openai_compatible: PlugZap,
}

export function SettingsPage({
  returnToCreate,
  variant = 'settings',
}: {
  returnToCreate?: {
    label: string
    onClick: () => void
  }
  variant?: 'settings' | 'login'
}) {
  const providers = useModelProviderSettings()
  const runtimeReadiness = useRuntimeReadiness()
  const settings = providers.settings
  const defaultProvider = settings?.providers.find((provider) => provider.id === settings.defaultProviderId)
  const otherProviders = settings?.providers.filter((provider) => provider.id !== settings.defaultProviderId) ?? []

  return (
    <AppPageFrame>
      <header className="flex flex-col gap-3 border-b border-line/70 pb-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-sub">
            {variant === 'login' ? 'AI 服务 · 模型凭据' : '本地优先 · 模型接入'}
          </span>
          <h1 className="text-[26px] font-semibold leading-tight md:text-[32px]">
            {variant === 'login' ? '登录与模型接入' : '设置'}
          </h1>
        </div>
        {returnToCreate && (
          <button
            type="button"
            onClick={returnToCreate.onClick}
            className="inline-flex w-fit items-center gap-2 rounded-full border border-line/70 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary"
          >
            <ArrowLeft className="size-3.5" />
            {returnToCreate.label}
          </button>
        )}
      </header>

      <section className="mx-auto grid w-full max-w-4xl gap-8">
        <div>
          <div className="mb-4">
            <h2 className="text-base font-semibold">AI 文案</h2>
            <p className="mt-1 text-sm text-sub">选择一个 AI 服务，保存并测试后即可开始聊天生成文案。</p>
          </div>
          <div className="flex flex-col border-y border-line/80">
          {providers.status === 'loading' && (
            <div className="py-10 text-sm text-sub">正在加载模型 Provider...</div>
          )}

          {defaultProvider && (
            <ProviderRow
              provider={defaultProvider}
              selected
              busy={providers.busy}
              onSelect={() => providers.selectDefaultProvider(defaultProvider.id)}
              onSave={() => providers.saveProvider(defaultProvider.id)}
              onTest={() => providers.runProviderTest(defaultProvider.id)}
              onChange={(patch) => providers.updateProviderDraft(defaultProvider.id, patch)}
            />
          )}
          </div>

          {otherProviders.length > 0 && (
            <details className="group border-b border-line/80 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
                更换 AI 服务
                <ChevronDown className="size-4 text-sub transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 border-t border-line/60">
                {otherProviders.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    selected={false}
                    busy={providers.busy}
                    onSelect={() => providers.selectDefaultProvider(provider.id)}
                    onSave={() => providers.saveProvider(provider.id)}
                    onTest={() => providers.runProviderTest(provider.id)}
                    onChange={(patch) => providers.updateProviderDraft(provider.id, patch)}
                  />
                ))}
              </div>
            </details>
          )}
          {providers.error && <p className="mt-3 text-sm leading-relaxed text-danger">{providers.error}</p>}
        </div>

        <details className="group border-y border-line/80 py-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">生成服务</h2>
              <p className="mt-1 text-sm text-sub">{runtimeReadinessSummary(runtimeReadiness.result, runtimeReadiness.loading)}</p>
            </div>
            <span className="flex items-center gap-2">
              <IconButton
                label="刷新运行环境"
                onClick={runtimeReadiness.refresh}
                disabled={runtimeReadiness.loading}
              >
                <RefreshCw className={cn('size-4', runtimeReadiness.loading && 'animate-spin')} />
              </IconButton>
              <ChevronDown className="size-4 text-sub transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="mt-4 border-t border-line/60 pt-1">
            <WindowsRuntimePanel />
            <ManagedRuntimePanel />
            <OpenChatCutRuntimePanel />
            <RuntimeReadinessPanel
              result={runtimeReadiness.result}
              loading={runtimeReadiness.loading}
              onConfigSave={runtimeReadiness.updateLocalRuntimeConfig}
            />
          </div>
        </details>

        <details className="group border-b border-line/80 pb-4">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
            高级与隐私设置
            <ChevronDown className="size-4 text-sub transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
            <div>
              <div className="font-semibold">数据边界</div>
              <p className="mt-1 leading-relaxed text-sub">本地服务不离开本机；云端服务会把文案发送到你选择的 Provider。</p>
            </div>
            <div>
              <div className="font-semibold">接入方式</div>
                <p className="mt-1 leading-relaxed text-sub">API Key 或 OpenAI-compatible 地址可直接使用。ChatGPT 订阅登录属于账号身份能力，不等同于 API 调用凭据。</p>
            </div>
            {variant === 'login' && (
              <div>
                <div className="font-semibold">ChatGPT 订阅登录</div>
                <p className="mt-1 leading-relaxed text-sub">ChatGPT Plus/Pro/Team 订阅登录不能直接作为模型 API 凭据。</p>
              </div>
            )}
            <label className="flex items-center justify-between gap-4">
              <span>遥测</span>
              <button
                type="button"
                onClick={providers.toggleTelemetry}
                disabled={!settings || providers.busy}
                className={cn('relative h-6 w-11 rounded-full transition-colors disabled:opacity-50', settings?.telemetryEnabled ? 'bg-foreground' : 'bg-secondary')}
                aria-label="切换遥测"
              >
                <span className={cn('absolute top-1 size-4 rounded-full bg-background transition-transform', settings?.telemetryEnabled ? 'translate-x-6' : 'translate-x-1')} />
              </button>
            </label>
            <p className="text-xs leading-relaxed text-sub md:col-span-2">API Key 不会在读取设置时明文返回。</p>
            <LegacyProjectImport />
          </div>
        </details>
      </section>
    </AppPageFrame>
  )
}

function LegacyProjectImport() {
  const client = useMemo(() => createProjectStateClient(), [])
  const [sourceRoot, setSourceRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [imported, setImported] = useState(false)

  async function runImport() {
    if (!sourceRoot.trim() || busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await client.importLegacy(sourceRoot.trim())
      if (result.status === 'ok' || result.status === 'partial') {
        const importedCount = result.imported?.length ?? 0
        const skippedCount = result.skipped?.length ?? 0
        const issueCount = result.issues?.length ?? 0
        setMessage(`已导入 ${importedCount} 个，跳过 ${skippedCount} 个，异常 ${issueCount} 个。源文件未修改。`)
        setImported(importedCount > 0)
      } else {
        setMessage(result.error?.message ?? '旧项目导入失败。')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="旧项目导入" className="border-t border-line/60 pt-4 md:col-span-2">
      <div className="font-semibold">导入旧项目</div>
      <p className="mt-1 text-xs leading-relaxed text-sub">填写旧版的 workspaces 文件夹绝对路径。应用只复制有效项目，不移动或删除原文件。</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="旧项目文件夹"
          value={sourceRoot}
          onChange={(event) => setSourceRoot(event.target.value)}
          placeholder="例如 D:\\旧版口播智能体\\data\\workspaces"
          className="h-9 min-w-0 flex-1 rounded-full border border-line bg-transparent px-3 text-sm outline-none focus:border-cyan"
        />
        <button type="button" onClick={runImport} disabled={busy || !sourceRoot.trim()} className="h-9 rounded-full bg-foreground px-4 text-xs font-medium text-background disabled:opacity-40">
          {busy ? '正在导入…' : '复制并导入'}
        </button>
      </div>
      {message && <p role="status" className="mt-2 text-xs leading-relaxed text-sub">{message}</p>}
      {imported && <button type="button" onClick={() => window.location.reload()} className="mt-2 text-xs font-medium text-cyan">重新载入项目</button>}
    </section>
  )
}

function RuntimeReadinessPanel({
  result,
  loading,
  onConfigSave,
}: {
  result: ReturnType<typeof useRuntimeReadiness>['result']
  loading: boolean
  onConfigSave: ReturnType<typeof useRuntimeReadiness>['updateLocalRuntimeConfig']
}) {
  if (loading && !result) {
    return <div className="mt-3 text-xs text-sub">正在检查运行环境...</div>
  }

  if (!result || result.status === 'error') {
    return (
      <div className="mt-3 text-xs leading-relaxed text-danger">
        {result?.error.message ?? '运行环境检查不可用。'}
      </div>
    )
  }

  return (
    <div className="mt-3 grid gap-3">
      {result.localRuntimeConfig && (
        <>
          <IndexTTS2ConfigForm
            config={result.localRuntimeConfig.indextts2}
            loading={loading}
            onSave={onConfigSave}
          />
          <DuixAvatarConfigForm
            config={result.localRuntimeConfig.duixAvatar}
            loading={loading}
            onSave={onConfigSave}
          />
        </>
      )}

      <div className="grid gap-2">
        {result.checks.map((check) => (
          <RuntimeReadinessItem key={check.id} check={check} />
        ))}
      </div>
    </div>
  )
}

function DuixAvatarConfigForm({
  config,
  loading,
  onSave,
}: {
  config: LocalDuixAvatarRuntimeConfig
  loading: boolean
  onSave: ReturnType<typeof useRuntimeReadiness>['updateLocalRuntimeConfig']
}) {
  const [draft, setDraft] = useState(() => ({
    ...config,
    timeoutMs: String(config.timeoutMs),
    pollIntervalMs: String(config.pollIntervalMs),
  }))
  const [message, setMessage] = useState('')

  useEffect(() => {
    setDraft({ ...config, timeoutMs: String(config.timeoutMs), pollIntervalMs: String(config.pollIntervalMs) })
  }, [config])

  async function save() {
    const timeoutMs = Number(draft.timeoutMs)
    const pollIntervalMs = Number(draft.pollIntervalMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
      setMessage('超时必须是 1000 至 3600000 毫秒的整数。')
      return
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) {
      setMessage('轮询间隔必须是 0 至 60000 毫秒的整数。')
      return
    }
    setMessage('')
    const result = await onSave({
      duixAvatar: {
        mode: draft.mode,
        apiUrl: draft.apiUrl,
        apiDialect: draft.apiDialect,
        publicAssetBaseUrl: draft.publicAssetBaseUrl,
        resultRoot: draft.resultRoot,
        hostDataRoot: draft.hostDataRoot,
        containerDataRoot: draft.containerDataRoot,
        scriptPath: draft.scriptPath,
        ffprobePath: draft.ffprobePath,
        timeoutMs,
        pollIntervalMs,
      },
    })
    setMessage(result.status === 'error' ? result.error.message : '已保存数字人运行配置。')
  }

  return (
    <section aria-label="Duix 数字人配置" className="grid gap-3 border border-line/70 p-3">
      <div>
        <div className="text-xs font-semibold">Duix / HeyGem 数字人</div>
        <p className="mt-1 text-[11px] text-sub">默认使用 KouboRuntime WSL，无需 Docker。API Key 只从环境变量读取，不会保存或返回。</p>
      </div>
      <fieldset className="grid gap-2 rounded-lg border border-line/60 p-2 text-xs">
        <legend className="px-1 text-sub">运行方式</legend>
        <label className="flex items-start gap-2"><input type="radio" name="duix-mode" checked={draft.mode === 'managed_wsl'} onChange={() => setDraft((value) => ({ ...value, mode: 'managed_wsl' }))} /><span><b>默认：KouboRuntime WSL</b><br /><span className="text-sub">免 Docker；仅使用已导入并就绪的本机受管运行包。</span></span></label>
        <label className="flex items-start gap-2"><input type="radio" name="duix-mode" checked={draft.mode === 'custom'} onChange={() => setDraft((value) => ({ ...value, mode: 'custom' }))} /><span><b>高级：自定义兼容 Runtime</b><br /><span className="text-sub">连接你明确配置的 API 或本机脚本。</span></span></label>
      </fieldset>
      {draft.mode === 'custom' && <>
        <div className="grid gap-2 md:grid-cols-2">
          <Input label="API 地址" value={draft.apiUrl} placeholder="http://127.0.0.1:8383" onChange={(apiUrl) => setDraft((value) => ({ ...value, apiUrl }))} />
          <label className="grid gap-1 text-xs text-sub">
            API 协议
            <select aria-label="API 协议" value={draft.apiDialect} onChange={(event) => setDraft((value) => ({ ...value, apiDialect: event.target.value as LocalDuixAvatarRuntimeConfig['apiDialect'] }))} className="h-9 border border-line bg-background px-3 text-sm text-foreground outline-none focus:border-cyan">
              <option value="duix_face2face">Duix Face2Face</option><option value="compatible_render">兼容 Render API</option>
            </select>
          </label>
        </div>
      <details className="group border-t border-line/60 pt-2">
        <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium">
          高级配置
          <ChevronDown className="size-3.5 text-sub transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <Input label="公开素材地址" value={draft.publicAssetBaseUrl} onChange={(publicAssetBaseUrl) => setDraft((value) => ({ ...value, publicAssetBaseUrl }))} />
          <Input label="结果目录" value={draft.resultRoot} onChange={(resultRoot) => setDraft((value) => ({ ...value, resultRoot }))} />
          <Input label="宿主数据目录" value={draft.hostDataRoot} onChange={(hostDataRoot) => setDraft((value) => ({ ...value, hostDataRoot }))} />
          <Input label="容器数据目录" value={draft.containerDataRoot} onChange={(containerDataRoot) => setDraft((value) => ({ ...value, containerDataRoot }))} />
          <Input label="本机启动脚本" value={draft.scriptPath} onChange={(scriptPath) => setDraft((value) => ({ ...value, scriptPath }))} />
          <Input label="ffprobe 路径（数字人）" value={draft.ffprobePath} onChange={(ffprobePath) => setDraft((value) => ({ ...value, ffprobePath }))} />
          <Input label="任务超时（毫秒）" value={draft.timeoutMs} onChange={(timeoutMs) => setDraft((value) => ({ ...value, timeoutMs }))} />
          <Input label="轮询间隔（毫秒）" value={draft.pollIntervalMs} onChange={(pollIntervalMs) => setDraft((value) => ({ ...value, pollIntervalMs }))} />
        </div>
      </details>
      </>}
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={loading} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background disabled:opacity-40">
          <Save className="size-3.5" />
          保存数字人配置
        </button>
        {message && <p role="status" className="text-xs text-sub">{message}</p>}
      </div>
    </section>
  )
}

function IndexTTS2ConfigForm({
  config,
  loading,
  onSave,
}: {
  config: LocalIndexTTS2RuntimeConfig
  loading: boolean
  onSave: ReturnType<typeof useRuntimeReadiness>['updateLocalRuntimeConfig']
}) {
  const [draft, setDraft] = useState(() => ({ ...config, timeoutMs: String(config.timeoutMs) }))
  const [message, setMessage] = useState('')

  useEffect(() => {
    setDraft({ ...config, timeoutMs: String(config.timeoutMs) })
  }, [config])

  async function save() {
    const timeoutMs = Number(draft.timeoutMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
      setMessage('超时必须是 1000 至 3600000 毫秒的整数。')
      return
    }
    setMessage('')
    const result = await onSave({
      indextts2: {
        runtimeRoot: draft.runtimeRoot,
        scriptPath: draft.scriptPath,
        ffmpegPath: draft.ffmpegPath,
        ffprobePath: draft.ffprobePath,
        timeoutMs,
      },
    })
    setMessage(result.status === 'error' ? result.error.message : '已保存本地声音运行配置。')
  }

  return (
    <section aria-label="IndexTTS2 本地配置" className="grid gap-3 border border-line/70 p-3">
      <div>
        <div className="text-xs font-semibold">IndexTTS2 本地配置</div>
        <p className="mt-1 text-[11px] text-sub">保存到本机 AppData，下次生成声音会自动重新读取。</p>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Input label="Runtime 根目录" value={draft.runtimeRoot} placeholder="C:\\IndexTTS2" onChange={(runtimeRoot) => setDraft((value) => ({ ...value, runtimeRoot }))} />
        <Input label="启动脚本" value={draft.scriptPath} placeholder="Invoke-NaturalTTS.ps1" onChange={(scriptPath) => setDraft((value) => ({ ...value, scriptPath }))} />
        <Input label="ffmpeg 路径" value={draft.ffmpegPath} onChange={(ffmpegPath) => setDraft((value) => ({ ...value, ffmpegPath }))} />
        <Input label="ffprobe 路径" value={draft.ffprobePath} onChange={(ffprobePath) => setDraft((value) => ({ ...value, ffprobePath }))} />
        <Input label="超时（毫秒）" value={draft.timeoutMs} onChange={(timeoutMs) => setDraft((value) => ({ ...value, timeoutMs }))} />
      </div>
      <RuntimePackageDownloadBoundary packageId="indextts2" label="声音克隆运行包" />
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={loading} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-medium text-background disabled:opacity-40">
          <Save className="size-3.5" />
          保存声音配置
        </button>
        {message && <p role="status" className="text-xs text-sub">{message}</p>}
      </div>
    </section>
  )
}

function runtimeReadinessSummary(
  result: ReturnType<typeof useRuntimeReadiness>['result'],
  loading: boolean,
) {
  if (loading && !result) return '正在检查声音、数字人、剪辑和发布环境…'
  if (!result || result.status === 'error') return '检查暂不可用，展开查看恢复方式。'
  if (result.summary.missing > 0) return `还需配置 ${result.summary.missing} 项；基础界面仍可使用。`
  if (result.summary.warning > 0) return `基础功能可用，另有 ${result.summary.warning} 项可选能力待确认。`
  return '当前所选配置已就绪。'
}

function RuntimeReadinessItem({ check }: { check: RuntimeReadinessCheck }) {
  return (
    <details className="group border-t border-line/60 pt-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
          <span className="text-sm font-medium">{check.title}</span>
        <span className="flex items-center gap-1">
          <span className={cn('rounded-full px-2 py-0.5 text-[11px]', runtimeStatusTone(check.status))}>
            {runtimeStatusLabel(check)}
          </span>
          <ChevronDown className="size-3 text-sub transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <p className="mt-1 text-xs leading-relaxed text-sub">
        {check.gaps[0] ?? check.nextStep}
      </p>
      <div className="mt-2 grid gap-1 text-xs">
        <span className="font-medium text-foreground/80">下一步</span>
        <p className="leading-relaxed text-sub">{check.nextStep}</p>
      </div>
    </details>
  )
}

function ProviderRow({
  provider,
  selected,
  busy,
  onSelect,
  onSave,
  onTest,
  onChange,
}: {
  provider: EditableModelProvider
  selected: boolean
  busy: boolean
  onSelect: () => void
  onSave: () => void
  onTest: () => void
  onChange: (patch: Partial<EditableModelProvider>) => void
}) {
  const Icon = KIND_ICON[provider.kind]

  return (
    <section aria-label={`${provider.name} 配置`} className="border-b border-line/80 py-5 last:border-b-0">
      <div className="flex min-w-0 gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
          <Icon className="size-4 text-foreground" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{provider.name}</span>
            {selected && <Check className="size-4 text-success" />}
            <span className={cn('rounded-full px-2 py-0.5 text-[11px]', statusTone(provider.status))}>
              {statusLabel(provider.status)}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-sub">{provider.note}</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-sub">
            <span>{dataLocationLabel(provider.dataLocation)}</span>
            <span className="text-line">/</span>
            <span>{authModeLabel(provider.authMode, provider.requiresApiKey)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:pl-12">
        <Input
          label="Base URL"
          value={provider.baseUrl}
          onChange={(baseUrl) => onChange({ baseUrl })}
        />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            label="Model"
            value={provider.model}
            onChange={(model) => onChange({ model })}
          />
          <Input
            label="API Key"
            value={provider.apiKeyInput}
            placeholder={provider.hasApiKey ? provider.apiKeyPreview : provider.requiresApiKey ? '需要 API Key' : '可选'}
            secret
            onChange={(apiKeyInput) => onChange({ apiKeyInput })}
          />
        </div>
        {provider.lastError && (
          <p className="text-xs leading-relaxed text-danger">{provider.lastError.message}</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line/60 pt-3 md:ml-12">
        <button
          type="button"
          onClick={() => onChange({ enabled: !provider.enabled })}
          disabled={busy}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-50',
            provider.enabled ? 'bg-foreground text-background' : 'bg-secondary text-sub',
          )}
        >
          {provider.enabled ? '已启用' : '已停用'}
        </button>
        {!selected && (
          <button type="button" onClick={onSelect} disabled={busy} className="rounded-full px-3 py-1.5 text-xs text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50">
            设为当前
          </button>
        )}
        <button type="button" onClick={onSave} disabled={busy} aria-label="保存" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50">
          <Save className="size-3.5" /> 保存
        </button>
        <button type="button" onClick={onTest} disabled={busy} aria-label="测试连接" className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50">
          <RefreshCw className="size-3.5" /> 测试连接
        </button>
      </div>
    </section>
  )
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-full text-sub transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function Input({
  label,
  value,
  placeholder,
  secret,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  secret?: boolean
  onChange: (value: string) => void
}) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] text-sub">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        type={secret ? 'password' : 'text'}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-full border border-line bg-transparent px-3 text-sm outline-none transition-colors placeholder:text-sub/55 focus:border-cyan"
      />
    </label>
  )
}

function statusLabel(status: ModelProviderStatus) {
  const labels: Record<ModelProviderStatus, string> = {
    disabled: '停用',
    missing_credentials: '待配置',
    configured: '待测试',
    testing: '测试中',
    connected: '已连接',
    auth_error: '认证失败',
    network_error: '网络失败',
    model_error: '模型错误',
    quota_error: '配额不足',
    runtime_error: '运行错误',
  }
  return labels[status]
}

function statusTone(status: ModelProviderStatus) {
  if (status === 'connected') return 'bg-success/15 text-success'
  if (status === 'configured' || status === 'testing') return 'bg-cyan/10 text-cyan'
  if (status === 'disabled') return 'bg-secondary text-sub'
  return 'bg-danger/10 text-danger'
}

function runtimeStatusLabel(check: RuntimeReadinessCheck) {
  if (check.optionalForCurrentProfile && check.status === 'warning') return '可选未配'
  const labels: Record<RuntimeReadinessCheckStatus, string> = {
    ready: '可用',
    missing: '缺配置',
    warning: '需确认',
  }
  return labels[check.status]
}

function runtimeStatusTone(status: RuntimeReadinessCheckStatus) {
  if (status === 'ready') return 'bg-success/15 text-success'
  if (status === 'warning') return 'bg-cyan/10 text-cyan'
  return 'bg-danger/10 text-danger'
}

function dataLocationLabel(location: ModelProviderDataLocation) {
  const labels: Record<ModelProviderDataLocation, string> = {
    local_only: '数据流向：仅本机',
    cloud_provider: '数据流向：云端 Provider',
    configured_endpoint: '数据流向：配置的 endpoint',
    custom_endpoint: '数据流向：自定义 endpoint',
  }
  return labels[location]
}

function authModeLabel(authMode: EditableModelProvider['authMode'], requiresApiKey: boolean) {
  if (authMode === 'none') return '接入方式：无需密钥'
  if (authMode === 'future_oauth') return '接入方式：账号授权规划中'
  return requiresApiKey ? '接入方式：API Key 必填' : '接入方式：API Key 可选'
}
