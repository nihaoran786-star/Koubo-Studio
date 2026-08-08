'use client'

import { useState } from 'react'
import type { ScriptDraft } from '@/lib/workspace'
import {
  buildScriptAgentMessage,
  buildScriptClarificationMessage,
  buildScriptRevisionMessage,
  createScriptAgentClient,
  mapScriptClarificationResultToDraft,
  mapScriptAgentResultToDraft,
  statusFromScriptAgentResult,
  type ScriptAgentClientResult,
  type ScriptAgentClientStatus,
} from './script-agent-client'

export interface ScriptAgentDraftTurnResult {
  draft: ScriptDraft
  result: ScriptAgentClientResult
}

export function useScriptAgent(projectId: string) {
  const [status, setStatus] = useState<ScriptAgentClientStatus>('idle')
  const [lastResult, setLastResult] = useState<ScriptAgentClientResult | undefined>()
  const client = createScriptAgentClient()

  async function clarifyDraft(script: ScriptDraft, userMessage: string) {
    setStatus('running')
    const result = await client.generate({
      projectId,
      message: buildScriptClarificationMessage(script, userMessage),
      turnType: 'clarify',
      approvalStatus: 'draft',
    })
    setLastResult(result)
    setStatus(statusFromScriptAgentResult(result))
    return {
      draft: mapScriptClarificationResultToDraft(script, result, {
        messageId: `ai-clarify-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }),
      result,
    } satisfies ScriptAgentDraftTurnResult
  }

  async function generateDraft(script: ScriptDraft) {
    setStatus('running')
    const result = await client.generate({
      projectId,
      message: buildScriptAgentMessage(script),
      turnType: 'generate_artifact',
      approvalStatus: 'draft',
    })
    setLastResult(result)
    setStatus(statusFromScriptAgentResult(result))
    return {
      draft: mapScriptAgentResultToDraft(script, result, {
        messageId: `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      }),
      result,
    } satisfies ScriptAgentDraftTurnResult
  }

  async function reviseDraft(script: ScriptDraft, instruction: string) {
    setStatus('running')
    const result = await client.generate({
      projectId,
      message: buildScriptRevisionMessage(script, instruction),
      turnType: 'generate_artifact',
      approvalStatus: 'draft',
      artifactId: script.artifactId,
    })
    setLastResult(result)
    setStatus(statusFromScriptAgentResult(result))
    return {
      draft: mapScriptAgentResultToDraft(script, result, {
        messageId: `ai-revised-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        successText: '已根据你的修改要求更新左侧文案。确认后可以进入下一步。',
      }),
      result,
    } satisfies ScriptAgentDraftTurnResult
  }

  async function approveDraft(script: ScriptDraft) {
    if (!script.artifactId) {
      setStatus('agent_error')
      return {
        ...script,
        approvalStatus: 'draft' as const,
        messages: [
          ...script.messages,
          {
            id: `ai-approval-error-${Date.now()}`,
            role: 'ai' as const,
            text: '还没有可确认的 script artifact，请先生成文案。',
          },
        ],
      }
    }
    setStatus('approving')
    const result = await client.approve({
      projectId,
      artifactId: script.artifactId,
    })
    if (result.status === 'ok') {
      setStatus('done')
      return {
        ...script,
        approvalStatus: 'approved' as const,
      }
    }
    setStatus('agent_error')
    return {
      ...script,
      approvalStatus: 'draft' as const,
      messages: [
        ...script.messages,
        {
          id: `ai-approval-error-${Date.now()}`,
          role: 'ai' as const,
          text: `确认文案失败（${result.error.code}）：${result.error.message}`,
        },
      ],
    }
  }

  return {
    status,
    lastResult,
    clarifyDraft,
    generateDraft,
    reviseDraft,
    approveDraft,
  }
}
