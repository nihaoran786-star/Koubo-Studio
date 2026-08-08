import type { ArtifactRecord } from '@/lib/artifacts/artifact-types'
import {
  saveScriptArtifact,
  updateScriptArtifactApproval,
  type ScriptApprovalStatus,
  type ScriptArtifact,
  type ScriptArtifactContent,
} from '@/lib/artifacts/script-artifact'
import type { FeatureType } from '@/lib/features/feature-registry'
import { runModelAgent, type RunModelAgentInput, type RunModelAgentResult } from './model-agent-service'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { appendAgentSessionMetadata } from './agent-session-index'
import { createAgentSessionMetadata } from './agent-session'
import { approveProjectScriptArtifact } from '@/lib/project-state/project-state-service'

export type ScriptAgentStatus =
  | 'ok'
  | 'needs_configuration'
  | 'agent_error'
  | 'script_parse_error'

type NonOkModelAgentResult = RunModelAgentResult & {
  status: Exclude<RunModelAgentResult['status'], 'ok'>
}

export interface RunScriptAgentInput {
  projectId: string
  message: string
  turnType?: ScriptAgentTurnType
  promptName?: string
  approvalStatus: ScriptApprovalStatus
  artifactId?: string
  now?: string
  runAgent?: (input: RunModelAgentInput) => Promise<RunModelAgentResult>
}

export type ScriptAgentTurnType = 'clarify' | 'generate_artifact'
export type ScriptClarificationReadiness = 'needs_more_context' | 'ready_to_generate' | 'unknown'

export type RunScriptAgentResult =
  | {
      status: 'ok'
      source: 'script_agent'
      turnType: 'generate_artifact'
      projectId: string
      featureType: FeatureType
      agent: RunModelAgentResult
      reply: string
      artifact: ScriptArtifact
      record: ArtifactRecord
    }
  | {
      status: 'ok'
      source: 'script_agent'
      turnType: 'clarify'
      projectId: string
      featureType: FeatureType
      agent: RunModelAgentResult
      reply: string
      clarification: ScriptClarificationState
    }
  | {
      status: 'script_parse_error'
      source: 'script_agent'
      turnType: 'generate_artifact'
      projectId: string
      featureType: FeatureType
      reply: string
      error: {
        code: 'script_parse_error'
        message: string
      }
    }
  | NonOkModelAgentResult

export interface ScriptClarificationState {
  readiness: ScriptClarificationReadiness
  canGenerate: boolean
}

export type ApproveScriptArtifactResult =
  | {
      status: 'ok'
      source: 'script_agent'
      artifact: ScriptArtifact
      record: ArtifactRecord
    }
  | {
      status: 'invalid_request' | 'artifact_error'
      source: 'script_agent'
      error: {
        code: string
        message: string
        retryable?: boolean
      }
    }

export async function runScriptAgent(input: RunScriptAgentInput): Promise<RunScriptAgentResult> {
  const featureType = 'digital-human' satisfies FeatureType
  const turnType = input.turnType ?? 'generate_artifact'
  const runAgent = input.runAgent ?? runModelAgent
  const agent = await runAgent({
    projectId: input.projectId,
    featureType,
    message: buildRuntimeMessage(input.message, turnType),
    promptName: input.promptName,
  })

  if (isNonOkModelAgentResult(agent)) {
    return agent
  }

  if (turnType === 'clarify') {
    const workspace = await ensureProjectWorkspace(input.projectId, featureType)
    const sessionId = agent.sessionId ?? `script-clarify-session-${Date.now()}`
    await recordScriptAgentSession({
      workspace,
      sessionId,
    })
    const clarification = parseClarificationReply(agent.reply)

    return {
      status: 'ok',
      source: 'script_agent',
      turnType,
      projectId: input.projectId,
      featureType,
      agent,
      reply: clarification.reply,
      clarification: clarification.state,
    }
  }

  let finalAgent = agent
  let parsed = parseScriptReply(finalAgent.reply)
  if (!parsed.ok) {
    const repairedAgent = await runAgent({
      projectId: input.projectId,
      featureType,
      message: buildRuntimeMessage(
        buildRepairMessage(input.message, finalAgent.reply, parsed.message),
        'generate_artifact',
      ),
      promptName: input.promptName,
    })
    if (isNonOkModelAgentResult(repairedAgent)) {
      return repairedAgent
    }
    finalAgent = repairedAgent
    parsed = parseScriptReply(finalAgent.reply)
  }
  if (!parsed.ok) {
    if (parsed.message === '模型回复缺少必需的文案字段') {
      return {
        status: 'script_parse_error',
        source: 'script_agent',
        turnType,
        projectId: input.projectId,
        featureType,
        reply: finalAgent.reply,
        error: {
          code: 'script_parse_error',
          message: parsed.message,
        },
      }
    }
    parsed = {
      ok: true,
      content: buildFallbackScriptContent(input.message, finalAgent.reply),
    }
  }

  const workspace = await ensureProjectWorkspace(input.projectId, featureType)
  const sessionId = finalAgent.sessionId ?? `script-session-${Date.now()}`
  const artifactId = input.artifactId ?? `script-${Date.now()}`
  const { artifact, record } = await saveScriptArtifact({
    workspace,
    artifactId,
    sessionId,
    approvalStatus: input.approvalStatus,
    content: parsed.content,
    now: input.now,
  })
  await recordScriptAgentSession({
    workspace,
    sessionId,
    artifactId: artifact.artifactId,
  })

  return {
    status: 'ok',
    source: 'script_agent',
    turnType,
    projectId: input.projectId,
    featureType,
    agent: finalAgent,
    reply: finalAgent.reply,
    artifact,
    record,
  }
}

async function recordScriptAgentSession({
  workspace,
  sessionId,
  artifactId,
}: {
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>
  sessionId: string
  artifactId?: string
}) {
  await appendAgentSessionMetadata(
    workspace,
    createAgentSessionMetadata({
      sessionId,
      sessionKind: 'main',
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.rootPath,
      agentRole: 'script',
      artifactId,
    }),
  )
}

function buildRuntimeMessage(
  message: string,
  turnType: ScriptAgentTurnType,
) {
  const modeInstruction = turnType === 'clarify'
    ? '本轮是澄清对话。请返回 JSON：{"reply":"给用户看的自然语言回复","readiness":"needs_more_context 或 ready_to_generate"}。'
    : '本轮是结构化文案生成。请返回符合 schema 的 JSON 文案。'
  return [modeInstruction, '', message].join('\n')
}

function buildRepairMessage(originalMessage: string, previousReply: string, parseError: string) {
  return [
    '上一轮没有生成可写入左侧文案模块的严格 JSON。',
    `解析失败原因：${parseError}`,
    '',
    '请只输出一个 JSON 对象，不要 Markdown 代码块，不要解释，不要追问。',
    'JSON 必须包含这些字段：title, hook, body, caption, tags, durationSeconds, voiceNotes, shotNotes, riskNotes。',
    'tags 必须是字符串数组；durationSeconds 必须是数字；riskNotes 没有风险时写空字符串。',
    '',
    '原始用户需求：',
    originalMessage.trim(),
    '',
    '上一轮回复：',
    previousReply.trim().slice(0, 4000),
  ].join('\n')
}

function buildFallbackScriptContent(originalMessage: string, previousReply: string): ScriptArtifactContent {
  const topic = normalizeTopic(originalMessage)
  const assistantText = previousReply.trim().replace(/\s+/g, ' ')
  const bodySeed = assistantText.length >= 24
    ? assistantText
    : `先用一句话说清楚 ${topic} 是什么，再给出一个马上能照做的小步骤，最后提醒观众从一个简单任务开始练习。`
  return {
    title: `${topic}口播`,
    hook: `如果你想快速了解${topic}，先别急着堆功能。`,
    body: trimToSentenceLength(bodySeed, 220),
    caption: `${topic}入门方法，先从一个清楚的小目标开始。`,
    tags: ['#口播', '#AI工具', `#${topic.replace(/\s+/g, '')}`],
    durationSeconds: 30,
    voiceNotes: '语速中等，语气自然清楚，重点词稍作停顿。',
    shotNotes: '正面半身数字人口播，按句切字幕，关键步骤用短字幕强调。',
    riskNotes: '模型返回了非结构化内容，系统已生成保守可编辑草稿；发布前需要人工检查事实和表达。',
  }
}

function normalizeTopic(value: string) {
  const cleaned = value
    .replace(/[。！？!?][\s\S]*$/, '')
    .replace(/^(请|帮我|我要|我想|做一条|生成一条|制作一条)/, '')
    .replace(/(的)?\d+\s*秒.*$/, '')
    .replace(/口播(视频)?$/, '')
    .trim()
  return cleaned || '这条视频'
}

function trimToSentenceLength(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1).trim()}…`
}

function parseClarificationReply(reply: string): { reply: string; state: ScriptClarificationState } {
  const fallback = reply.trim()
  const jsonText = extractJson(reply)
  if (!jsonText) {
    return {
      reply: fallback,
      state: {
        readiness: 'unknown',
        canGenerate: false,
      },
    }
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<{
      reply: unknown
      message: unknown
      readiness: unknown
      canGenerate: unknown
    }>
    const normalizedReadiness = normalizeClarificationReadiness(parsed.readiness)
    return {
      reply: readClarificationText(parsed.reply, parsed.message, fallback),
      state: {
        readiness: normalizedReadiness,
        canGenerate: typeof parsed.canGenerate === 'boolean'
          ? parsed.canGenerate
          : normalizedReadiness === 'ready_to_generate',
      },
    }
  } catch {
    return {
      reply: fallback,
      state: {
        readiness: 'unknown',
        canGenerate: false,
      },
    }
  }
}

function normalizeClarificationReadiness(value: unknown): ScriptClarificationReadiness {
  if (value === 'needs_more_context' || value === 'ready_to_generate') return value
  return 'unknown'
}

function readClarificationText(reply: unknown, message: unknown, fallback: string) {
  if (typeof reply === 'string' && reply.trim()) return reply.trim()
  if (typeof message === 'string' && message.trim()) return message.trim()
  return fallback
}

export async function approveScriptArtifactForProject(input: {
  projectId: string
  artifactId: string
  now?: string
  updateApproval?: typeof updateScriptArtifactApproval
  approveProjectScript?: typeof approveProjectScriptArtifact
}): Promise<ApproveScriptArtifactResult> {
  if (!input.artifactId.trim()) {
    return {
      status: 'invalid_request',
      source: 'script_agent',
      error: {
        code: 'missing_artifact_id',
        message: 'artifactId 不能为空。',
      },
    }
  }

  let approved: Awaited<ReturnType<typeof updateScriptArtifactApproval>>
  try {
    const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
    approved = await (input.updateApproval ?? updateScriptArtifactApproval)({
      workspace,
      artifactId: input.artifactId,
      approvalStatus: 'approved',
      now: input.now,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'artifact_error',
      source: 'script_agent',
      error: {
        code: 'script_artifact_approval_failed',
        message,
        retryable: true,
      },
    }
  }

  try {
    await (input.approveProjectScript ?? approveProjectScriptArtifact)({
      projectId: input.projectId,
      artifactId: approved.artifact.artifactId,
      now: input.now,
    })
    return {
      status: 'ok' as const,
      source: 'script_agent' as const,
      artifact: approved.artifact,
      record: approved.record,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'artifact_error',
      source: 'script_agent',
      error: {
        code: 'project_script_sync_failed',
        message: `文案已确认，但项目状态同步失败，请重试确认。${message ? ` 原因：${message}` : ''}`,
        retryable: true,
      },
    }
  }
}

function isNonOkModelAgentResult(result: RunModelAgentResult): result is NonOkModelAgentResult {
  return result.status !== 'ok'
}

function parseScriptReply(reply: string): { ok: true; content: ScriptArtifactContent } | { ok: false; message: string } {
  const jsonText = extractJson(reply)
  if (!jsonText) {
    return { ok: false, message: '模型回复中没有可解析的 JSON 文案' }
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<ScriptArtifactContent>
    const content = normalizeScriptReply(parsed)
    if (!content) {
      return { ok: false, message: '模型回复缺少必需的文案字段' }
    }
    return { ok: true, content }
  } catch {
    return { ok: false, message: '模型回复 JSON 格式无效' }
  }
}

function extractJson(reply: string) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]?.trim()) return fenced[1].trim()

  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return ''
  return reply.slice(start, end + 1)
}

function normalizeScriptReply(value: Partial<ScriptArtifactContent>): ScriptArtifactContent | undefined {
  if (
    typeof value.title !== 'string' ||
    typeof value.hook !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.caption !== 'string' ||
    !Array.isArray(value.tags) ||
    typeof value.durationSeconds !== 'number' ||
    typeof value.voiceNotes !== 'string' ||
    typeof value.shotNotes !== 'string' ||
    typeof value.riskNotes !== 'string'
  ) {
    return undefined
  }

  return {
    title: value.title,
    hook: value.hook,
    body: value.body,
    caption: value.caption,
    tags: value.tags.filter((tag): tag is string => typeof tag === 'string'),
    durationSeconds: value.durationSeconds,
    voiceNotes: value.voiceNotes,
    shotNotes: value.shotNotes,
    riskNotes: value.riskNotes,
  }
}
