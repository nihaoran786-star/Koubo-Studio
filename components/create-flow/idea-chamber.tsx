'use client'

import { useEffect, useState } from 'react'
import { Check, Pencil, RotateCcw, Wand2 } from 'lucide-react'
import { AgentChat, type AgentChatMessage } from '@/components/agent-chat/agent-chat'
import {
  configurationNoticeFromScriptAgentResult,
  type ScriptAgentConfigurationNotice,
  type ScriptAgentClientResult,
} from '@/lib/agents/script-agent-client'
import { useScriptAgent } from '@/lib/agents/use-script-agent'
import type { ScriptDraft } from '@/lib/workspace'
import { cn } from '@/lib/utils'
import { useModelProviderSettings } from '@/lib/model-providers/use-model-provider-settings'

type ScriptKey = 'title' | 'hook' | 'body' | 'caption'

const DEFAULT_PLATFORMS = ['抖音', '小红书']

export function IdeaChamber({
  projectId,
  script,
  onChange,
  onNext,
  onOpenSettings,
}: {
  projectId: string
  script: ScriptDraft
  onChange: (script: ScriptDraft) => void
  onNext: () => void
  onOpenSettings?: () => void
}) {
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState<ScriptKey | null>(null)
  const [snapshot, setSnapshot] = useState<ScriptDraft | null>(null)
  const [localConfigurationNotice, setLocalConfigurationNotice] = useState<ScriptAgentConfigurationNotice | undefined>()
  const [pendingGenerateScript, setPendingGenerateScript] = useState<ScriptDraft | null>(null)
  const scriptAgent = useScriptAgent(projectId)
  const configurationNotice = configurationNoticeFromScriptAgentResult(scriptAgent.lastResult)
  const visibleConfigurationNotice = localConfigurationNotice ?? configurationNotice

  const ready = script.chatStage === 'generated' || script.generated
  const approved = script.approvalStatus === 'approved'
  const hasBrief = script.chatStage !== 'brief' || script.topic.trim().length > 0
  const chatDisabled = scriptAgent.status === 'running' || scriptAgent.status === 'approving'

  function patch(patchValue: Partial<ScriptDraft>) {
    onChange({ ...script, approvalStatus: 'draft', ...patchValue })
  }

  function addMessage(role: 'ai' | 'user', text: string) {
    return {
      id: `${Date.now()}-${role}-${Math.random().toString(16).slice(2)}`,
      role,
      text,
    }
  }

  function chatMessages(): AgentChatMessage[] {
    const baseMessages = script.messages.map((message) => ({
      id: message.id,
      type: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
    }) satisfies AgentChatMessage)

    return baseMessages
  }

  function finishScriptAgentTurn(result: ScriptAgentClientResult) {
    setLocalConfigurationNotice(configurationNoticeFromScriptAgentResult(result))
  }

  function updateInput(value: string) {
    setInput(value)
    setPendingGenerateScript(null)
  }

  async function send(text = input) {
    const value = text.trim()
    if (!value) return

    if (script.chatStage === 'brief') {
      const topic = value
      const nextScript = {
        ...script,
        topic,
        chatStage: 'chatting',
        platforms: DEFAULT_PLATFORMS,
        messages: [
          addMessage('user', value),
        ],
      } satisfies ScriptDraft
      patch(nextScript)
      setInput('')
      const turn = await scriptAgent.clarifyDraft(nextScript, topic)
      finishScriptAgentTurn(turn.result)
      setPendingGenerateScript(shouldOfferGenerate(turn.result) ? turn.draft : null)
      onChange({ ...turn.draft, approvalStatus: 'draft' })
      return
    }

    if (ready) {
      const nextScript = {
        ...script,
        messages: [...script.messages, addMessage('user', value)],
      }
      patch({ messages: nextScript.messages })
      setInput('')
      const turn = await scriptAgent.reviseDraft(nextScript, value)
      finishScriptAgentTurn(turn.result)
      onChange({ ...turn.draft, approvalStatus: 'draft' })
      return
    }

    const nextScript = {
      ...script,
      messages: [...script.messages, addMessage('user', value)],
      tone: value.includes('口语') ? '口语亲切' : script.tone,
    }
    patch(nextScript)
    setInput('')
    const turn = await scriptAgent.clarifyDraft(nextScript, value)
    finishScriptAgentTurn(turn.result)
    setPendingGenerateScript(shouldOfferGenerate(turn.result) ? turn.draft : null)
    onChange({ ...turn.draft, approvalStatus: 'draft' })
  }

  async function generate() {
    const baseScript = pendingGenerateScript ?? script
    const topic = baseScript.topic.trim() || input.trim()
    const nextScript = topic && !baseScript.topic.trim() ? { ...baseScript, topic } : baseScript
    const turn = await scriptAgent.generateDraft(nextScript)
    finishScriptAgentTurn(turn.result)
    setPendingGenerateScript(null)
    onChange({ ...turn.draft, approvalStatus: 'draft' })
  }

  async function approve() {
    const nextScript = await scriptAgent.approveDraft(script)
    onChange(nextScript)
  }

  function improve() {
    setSnapshot(script)
    patch({
      hook: script.hook.replace('先别急着学一堆命令', '先把要做的事说成一句话'),
      body: `${script.body}\n\n记住：好的 AI 协作不是一次说完，而是让每一步都有反馈、有检查、有下一步。`,
      messages: [...script.messages, addMessage('ai', '已把表达改得更口语，左侧保留了可手动编辑的版本。')],
    })
  }

  function undo() {
    if (!snapshot) return
    onChange(snapshot)
    setSnapshot(null)
  }

  if (!hasBrief) {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col justify-center overflow-hidden">
        <AiSetupDialog onOpenSettings={onOpenSettings} />
        <div className="mb-4 h-1 w-14 rounded-full bg-cyan" />
        <h2 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.05em] md:text-[56px]">
          今天想做什么？
        </h2>
        <div className="mt-8 min-h-[260px]">
          {visibleConfigurationNotice && (
            <ScriptAgentConfigurationNoticeView
              notice={visibleConfigurationNotice}
              onOpenSettings={onOpenSettings}
            />
          )}
          <AgentChat
            messages={chatMessages()}
            input={input}
            placeholder="例如：做一条介绍 Codex 入门的 30 秒口播视频"
            disabled={chatDisabled}
            loading={chatDisabled}
            onInputChange={updateInput}
            onSend={(value) => void send(value)}
          />
          <InlineGenerateAction
            visible={Boolean(pendingGenerateScript)}
            disabled={scriptAgent.status === 'running'}
            onGenerate={() => void generate()}
          />
        </div>
        <p className="mt-4 text-sm text-sub">默认发布：抖音 / 小红书</p>
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden pt-4">
      <AiSetupDialog onOpenSettings={onOpenSettings} />
      {ready && (
        <div className="flow-action-dock">
          {snapshot && (
            <button
              onClick={undo}
              className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-sub hover:text-foreground"
            >
              <RotateCcw className="size-3.5" /> 撤销
            </button>
          )}
          <button
            onClick={() => void approve()}
            disabled={scriptAgent.status === 'approving'}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              approved ? 'bg-success/12 text-success' : 'bg-secondary text-foreground hover:bg-accent',
              scriptAgent.status === 'approving' && 'opacity-60',
            )}
          >
            <Check className="size-3.5" /> {approved ? '已确认文案' : scriptAgent.status === 'approving' ? '确认中…' : '确认文案'}
          </button>
          {approved && (
            <button
              onClick={onNext}
              className="flow-next-button"
            >
              下一步
            </button>
          )}
        </div>
      )}

      <div className="grid h-full min-h-0 gap-8 pt-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <article className="min-h-0 max-w-2xl overflow-y-auto overscroll-contain pr-3">
          {ready ? (
            <>
              <div className="grid gap-6">
                <DocField
                  label="标题"
                  value={script.title}
                  editing={editing === 'title'}
                  large
                  onEdit={() => setEditing('title')}
                  onDone={() => setEditing(null)}
                  onChange={(title) => patch({ title })}
                />
                <DocField
                  label="开头钩子"
                  value={script.hook}
                  editing={editing === 'hook'}
                  onEdit={() => setEditing('hook')}
                  onDone={() => setEditing(null)}
                  onChange={(hook) => patch({ hook })}
                />
                <DocField
                  label="口播正文"
                  value={script.body}
                  editing={editing === 'body'}
                  rows={7}
                  onEdit={() => setEditing('body')}
                  onDone={() => setEditing(null)}
                  onChange={(body) => patch({ body })}
                />
                <DocField
                  label="平台文案"
                  value={script.caption}
                  editing={editing === 'caption'}
                  onEdit={() => setEditing('caption')}
                  onDone={() => setEditing(null)}
                  onChange={(caption) => patch({ caption })}
                />
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[380px] flex-col justify-center border-b border-line/80">
              <div className="mb-4 h-1 w-14 rounded-full bg-cyan" />
              <h2 className="text-[32px] font-semibold leading-tight tracking-[-0.04em]">
                先聊清楚，再出文案。
              </h2>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-sub">
                右侧 AI 会追问几个关键点。信息够了以后，再生成左侧文本模块。
              </p>
            </div>
          )}
        </article>

        <aside
          className={cn(
            'flex h-full min-h-0 flex-col overflow-hidden border-t border-line/70 pt-5 lg:border-l lg:border-t-0 lg:pl-7',
            ready ? 'lg:pt-16' : 'lg:pt-0',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <span className="text-sm font-semibold">AI 协同</span>
              <p className="mt-1 text-xs leading-relaxed text-sub">提出修改意图，左侧文案保持可编辑。</p>
            </div>
            {ready ? (
              <button
                onClick={improve}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-cyan hover:text-white"
              >
                <Wand2 className="size-3.5" /> 更口语
              </button>
            ) : (
              <button
                onClick={generate}
                disabled={scriptAgent.status === 'running'}
                className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-cyan hover:text-white"
              >
                {scriptAgent.status === 'running' ? '生成中…' : '生成文案'}
              </button>
            )}
          </div>
          {visibleConfigurationNotice && (
            <ScriptAgentConfigurationNoticeView
              notice={visibleConfigurationNotice}
              onOpenSettings={onOpenSettings}
            />
          )}
          {scriptAgent.status === 'script_parse_error' && (
            <p className="mb-3 rounded-[18px] bg-warning/10 px-3 py-2 text-xs leading-relaxed text-sub">
              AI 回复没有形成可写入左侧的结构化文案，可以补充要求后重新生成。
            </p>
          )}

          <AgentChat
            messages={chatMessages()}
            input={input}
            placeholder={ready ? '告诉 AI 怎么改左侧文案…' : '补充目标用户、语气或重点…'}
            disabled={chatDisabled}
            loading={chatDisabled}
            onInputChange={updateInput}
            onSend={(value) => void send(value)}
          />
          <InlineGenerateAction
            visible={Boolean(pendingGenerateScript)}
            disabled={scriptAgent.status === 'running'}
            onGenerate={() => void generate()}
          />

          {ready && (
            <div className="mt-3 flex flex-wrap gap-2">
              {script.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-secondary px-2.5 py-1 text-xs text-sub">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function InlineGenerateAction({
  visible,
  disabled,
  onGenerate,
}: {
  visible: boolean
  disabled: boolean
  onGenerate: () => void
}) {
  if (!visible) return null
  return (
    <div className="mt-3 flex justify-end">
      <button
        type="button"
        onClick={onGenerate}
        disabled={disabled}
        className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-cyan hover:text-white disabled:opacity-60"
      >
        生成左侧文案
      </button>
    </div>
  )
}

/** 首次缺少 API Key 时的最短路径；凭据仅提交到设置接口，绝不回显已有密钥。 */
function AiSetupDialog({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const providers = useModelProviderSettings()
  const [open, setOpen] = useState(false)
  const settings = providers.settings
  const defaultProvider = settings?.providers.find((provider) => provider.id === settings.defaultProviderId)
  const needsKey = Boolean(defaultProvider?.requiresApiKey && !defaultProvider.hasApiKey)

  useEffect(() => {
    if (needsKey) setOpen(true)
  }, [needsKey])

  if (!open || !defaultProvider) return null
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ai-setup-title" className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-background p-5 shadow-2xl">
        <h2 id="ai-setup-title" className="text-lg font-semibold">先连接一个 AI，文案才会开始生成</h2>
        <p className="mt-2 text-sm leading-relaxed text-sub">
          当前默认使用 {defaultProvider.name}。API Key 只保存在这台电脑的本地设置中，用于调用你选择的模型服务，不会显示或上传已有密钥。
        </p>
        <label className="mt-4 block text-sm font-medium" htmlFor="default-provider-api-key">{defaultProvider.name} API Key</label>
        <input
          id="default-provider-api-key"
          type="password"
          autoComplete="off"
          value={defaultProvider.apiKeyInput}
          onChange={(event) => providers.updateProviderDraft(defaultProvider.id, { apiKeyInput: event.target.value, enabled: true })}
          placeholder={`粘贴你的 ${defaultProvider.name} API Key`}
          className="mt-2 h-10 w-full rounded-lg border border-line bg-transparent px-3 text-sm outline-none focus:border-cyan"
        />
        <p className="mt-2 text-xs text-sub">接口：{defaultProvider.baseUrl} · 模型：{defaultProvider.model}</p>
        {providers.error && <p role="alert" className="mt-3 text-xs text-danger">{providers.error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-full px-3 py-2 text-xs text-sub hover:bg-secondary">稍后配置</button>
          {onOpenSettings && <button type="button" onClick={onOpenSettings} className="rounded-full border border-line px-3 py-2 text-xs font-medium">打开完整设置</button>}
          <button
            type="button"
            disabled={providers.busy || !defaultProvider.apiKeyInput.trim()}
            onClick={() => void providers.runProviderTest(defaultProvider.id)}
            className="rounded-full bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-40"
          >
            {providers.status === 'testing' ? '正在保存并测试…' : '保存并测试'}
          </button>
        </div>
      </div>
    </div>
  )
}

function shouldOfferGenerate(result: ScriptAgentClientResult) {
  return result.status === 'ok' &&
    result.turnType === 'clarify' &&
    result.clarification.canGenerate
}

function ScriptAgentConfigurationNoticeView({
  notice,
  onOpenSettings,
}: {
  notice: ScriptAgentConfigurationNotice
  onOpenSettings?: () => void
}) {
  return (
    <div className="mb-3 rounded-[18px] bg-warning/10 px-3 py-2 text-xs leading-relaxed text-sub">
      <p className="font-semibold text-foreground/80">
        {notice.title}
      </p>
      <p className="mt-1">{notice.detail}</p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p>{notice.action}</p>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="shrink-0 rounded-full border border-line/70 bg-background/70 px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            打开设置
          </button>
        )}
      </div>
    </div>
  )
}

function DocField({
  label,
  value,
  editing,
  large,
  rows = 3,
  onEdit,
  onDone,
  onChange,
}: {
  label: string
  value: string
  editing: boolean
  large?: boolean
  rows?: number
  onEdit: () => void
  onDone: () => void
  onChange: (value: string) => void
}) {
  return (
    <section className="border-b border-line/80 pb-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-sub">{label}</span>
        <button
          onClick={editing ? onDone : onEdit}
          className="inline-flex items-center gap-1 text-xs text-sub hover:text-foreground"
        >
          {editing ? <Check className="size-3.5" /> : <Pencil className="size-3.5" />}
          {editing ? '保存' : '编辑'}
        </button>
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={value}
          rows={rows}
          onChange={(event) => onChange(event.target.value)}
          className="w-full resize-none bg-transparent text-[15px] leading-loose outline-none"
        />
      ) : large ? (
        <h3 className="text-[28px] font-semibold leading-tight tracking-[-0.04em]">
          {value}
        </h3>
      ) : (
        <p className="whitespace-pre-line text-[15px] leading-loose text-foreground/86">
          {value}
        </p>
      )}
    </section>
  )
}
