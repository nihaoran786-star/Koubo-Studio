'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, FileVideo2, ShieldCheck } from 'lucide-react'
import { ChamberShell, FooterBar, PrimaryButton } from './chamber-shell'
import { StatusPill } from './status-pill'
import { usePublishAgent } from '@/lib/publish/use-publish-agent'
import { useBrowserPublish } from '@/lib/publish/use-browser-publish'
import { PUBLISH_PLATFORMS } from '@/lib/publish/publish-platforms'
import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import type { ScriptDraft } from '@/lib/workspace'
import { cn } from '@/lib/utils'

export function PublishChamber({
  projectId,
  postProductionArtifactId,
  selectedPublishPackageArtifactId,
  script,
  onPrev,
}: {
  projectId: string
  postProductionArtifactId?: string
  selectedPublishPackageArtifactId?: string
  script: ScriptDraft
  onPrev: () => void
}) {
  const [selectedPlatforms, setSelectedPlatforms] = useState<PublishPlatformId[]>(['douyin', 'xiaohongshu'])
  const [title, setTitle] = useState(script.title || script.topic)
  const [description, setDescription] = useState(script.caption || script.body)
  const [tags, setTags] = useState(script.tags.join(' '))
  const [copied, setCopied] = useState(false)
  const publishAgent = usePublishAgent(projectId)
  const browserPublish = useBrowserPublish(projectId)

  useEffect(() => {
    void publishAgent.checkHealth()
    if (selectedPublishPackageArtifactId) void publishAgent.load(selectedPublishPackageArtifactId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, selectedPublishPackageArtifactId])

  const artifact = publishAgent.lastResult?.status === 'ready' ? publishAgent.lastResult.artifact : undefined
  const error = publishAgent.lastResult?.status === 'invalid_request' || publishAgent.lastResult?.status === 'publish_error'
    ? publishAgent.lastResult.error
    : undefined
  const missingInput = !postProductionArtifactId
    ? '请先在剪辑步骤导出最终成片。'
    : selectedPlatforms.length === 0
      ? '至少选择一个平台。'
      : ''
  const packageText = useMemo(() => [title, description, tags].filter(Boolean).join('\n\n'), [description, tags, title])

  function togglePlatform(platformId: PublishPlatformId) {
    setSelectedPlatforms((current) => current.includes(platformId)
      ? current.filter((item) => item !== platformId)
      : [...current, platformId])
  }

  async function preparePackage() {
    if (!postProductionArtifactId || selectedPlatforms.length === 0) return
    const result = await publishAgent.prepare({
      sessionId: `publish-${Date.now()}`,
      input: {
        platforms: selectedPlatforms,
        title,
        description,
        tags: tags.split(/\s+/).filter(Boolean),
      },
    })
    return result
  }

  async function copyPackageText() {
    await navigator.clipboard?.writeText(packageText)
    setCopied(true)
  }

  const activeBrowserPlatform = browserPublish.snapshot.platformId

  function browserAction(platformId: PublishPlatformId) {
    if (!artifact) return
    if (browserPublish.snapshot.status === 'awaiting_user_submit') return
    if (browserPublish.snapshot.status === 'login_required' && activeBrowserPlatform === platformId) {
      void browserPublish.refresh()
      return
    }
    if (browserPublish.snapshot.status === 'ready_to_fill' && activeBrowserPlatform === platformId) {
      void browserPublish.fill(artifact.artifactId, platformId)
      return
    }
    void browserPublish.open(artifact.artifactId, platformId)
  }

  function browserActionLabel(platformId: PublishPlatformId) {
    if (browserPublish.busy && activeBrowserPlatform === platformId) return '处理中…'
    if (activeBrowserPlatform !== platformId) return '打开并登录'
    if (browserPublish.snapshot.status === 'login_required') return '登录完成，检查状态'
    if (browserPublish.snapshot.status === 'ready_to_fill') return '自动填写发布内容'
    if (browserPublish.snapshot.status === 'awaiting_user_submit') return '已填好，等待你发布'
    if (browserPublish.snapshot.status === 'failed') return '重新打开'
    return '打开并登录'
  }

  function browserActionLabelWithConflict(platformId: PublishPlatformId) {
    if (browserPublish.snapshot.status === 'awaiting_user_submit' && activeBrowserPlatform !== platformId) {
      return '请先结束当前平台'
    }
    return browserActionLabel(platformId)
  }

  return (
    <ChamberShell
      code="05 / 发布"
      title="准备发布"
      statusPill={artifact
        ? <StatusPill label="发布包已准备" tone="success" />
        : <StatusPill label="本地准备" tone="cyan" />}
      footer={(
        <FooterBar center={(
          <div className="flex items-center gap-2">
            <PrimaryButton tone="ghost" onClick={onPrev}>返回剪辑</PrimaryButton>
            <PrimaryButton
              onClick={preparePackage}
              loading={publishAgent.status === 'running'}
              disabled={Boolean(missingInput)}
            >
              {artifact ? '重新准备发布包' : '准备发布包'}
            </PrimaryButton>
          </div>
        )} />
      )}
    >
      <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8 lg:grid-cols-[1fr_0.9fr]">
        <section className="grid content-start gap-5">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-sub">最后一步</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">整理发布内容</h1>
            <p className="mt-2 text-sm leading-6 text-sub">
              先生成本地发布包，再打开可见浏览器自动填写。登录、验证码和最终发布由你监督并确认。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {PUBLISH_PLATFORMS.map((platform) => {
              const selected = selectedPlatforms.includes(platform.id)
              return (
                <button
                  key={platform.id}
                  type="button"
                  onClick={() => togglePlatform(platform.id)}
                  className={cn(
                    'min-h-24 border p-4 text-left transition-colors',
                    selected ? 'border-foreground bg-secondary/55' : 'border-line/70 hover:border-foreground/35',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{platform.name}</span>
                    {selected && <Check className="size-4" />}
                  </span>
                  <span className="mt-2 block text-xs leading-5 text-sub">{platform.hint}</span>
                </button>
              )
            })}
          </div>

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="h-10 border border-line bg-transparent px-3 outline-none focus:border-foreground/50" />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">正文</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={6} className="resize-none border border-line bg-transparent p-3 leading-6 outline-none focus:border-foreground/50" />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">标签</span>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="#数字人 #口播" className="h-10 border border-line bg-transparent px-3 outline-none focus:border-foreground/50" />
          </label>
          {missingInput && <p className="text-sm text-[#a9700e]">{missingInput}</p>}
          {error && <p className="text-sm text-danger">{error.message}</p>}
        </section>

        <aside className="grid content-start gap-4 border border-line/70 bg-secondary/25 p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-full bg-background"><FileVideo2 className="size-5" /></span>
            <div>
              <p className="text-sm font-semibold">本地发布包</p>
              <p className="text-xs text-sub">成片 + 封面 + 标题 + 正文 + 标签</p>
            </div>
          </div>

          {artifact ? (
            <div className="grid gap-4">
              <div className="border-t border-line/70 pt-4 text-xs leading-6 text-sub">
                <p className="truncate">视频：{artifact.videoPath}</p>
                {artifact.coverPath && <p className="truncate">封面：{artifact.coverPath}</p>}
              </div>
              <button type="button" onClick={copyPackageText} className="flex items-center justify-center gap-2 border border-line px-3 py-2 text-sm hover:border-foreground/40">
                <Copy className="size-4" />{copied ? '已复制文案' : '复制发布文案'}
              </button>
              <div className="grid gap-2">
                {artifact.platforms.map((platform) => (
                  <button
                    key={platform.platformId}
                    type="button"
                    onClick={() => browserAction(platform.platformId)}
                    disabled={browserPublish.busy || browserPublish.snapshot.status === 'awaiting_user_submit'}
                    className="flex items-center justify-between border border-line px-3 py-2 text-left text-sm hover:border-foreground/40 disabled:cursor-default disabled:opacity-70"
                  >
                    <span>{platform.platformName} · {browserActionLabelWithConflict(platform.platformId)}</span><ExternalLink className="size-4" />
                  </button>
                ))}
              </div>
              {browserPublish.snapshot.error ? (
                <p className="text-xs leading-5 text-danger">{browserPublish.snapshot.error.message}</p>
              ) : null}
              {browserPublish.snapshot.status === 'awaiting_user_submit' ? (
                <div className="grid gap-2 border border-cyan/35 bg-cyan/5 p-3 text-xs leading-5">
                  <p>视频和文案已自动填写。请在可见浏览器中检查，最终发布按钮只由你点击。应用不会判断平台是否发布成功。</p>
                  <button type="button" onClick={() => void browserPublish.close()} className="justify-self-start underline underline-offset-4">已完成或放弃，结束当前会话</button>
                </div>
              ) : null}
              <div className="flex gap-2 border-t border-line/70 pt-4 text-xs leading-5 text-sub">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                <p>使用独立浏览器登录目录；不会读取密码、绕过验证，也没有自动点击最终发布的能力。</p>
              </div>
            </div>
          ) : (
            <div className="border-t border-line/70 pt-4 text-sm leading-6 text-sub">
              生成后会保存与当前成片关联的发布包。准备完成不代表平台已经发布。
            </div>
          )}
        </aside>
      </div>
    </ChamberShell>
  )
}
