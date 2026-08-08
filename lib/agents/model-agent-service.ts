import fs from 'node:fs/promises'
import path from 'node:path'
import type { FeatureType } from '@/lib/features/feature-registry'
import { getFeatureConfig } from '@/lib/features/feature-registry'
import { resolveDefaultModelProvider } from '@/lib/model-providers/model-provider-resolution'
import type { ModelProviderResolutionResult } from '@/lib/model-providers/model-provider-resolution'
import { ModelChatError, requestOpenAICompatibleChat } from '@/lib/model-providers/openai-compatible-chat-adapter'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'

export type ModelAgentStatus = 'ok' | 'needs_configuration' | 'agent_error'

export interface RunModelAgentInput {
  projectId: string
  featureType: FeatureType
  message: string
  promptName?: string
  resolveProvider?: () => Promise<ModelProviderResolutionResult>
  requestChat?: typeof requestOpenAICompatibleChat
}

export interface RunModelAgentResult {
  status: ModelAgentStatus
  source: 'model_agent'
  projectId: string
  featureType: FeatureType
  sessionId?: string
  workspacePath: string
  reply: string
  error?: { code: string; message: string }
}

export async function runModelAgent(input: RunModelAgentInput): Promise<RunModelAgentResult> {
  const workspace = await ensureProjectWorkspace(input.projectId, input.featureType)
  const feature = getFeatureConfig(input.featureType)

  try {
    const providerResolution = await (input.resolveProvider ?? resolveDefaultModelProvider)()
    if (providerResolution.status !== 'ok') {
      return failure('needs_configuration', providerResolution.error.code, providerResolution.error.message)
    }

    const [systemPrompt, promptTemplate] = await Promise.all([
      fs.readFile(feature.systemPromptPath, 'utf8'),
      readPromptTemplate(feature.promptsDir, input.promptName ?? feature.defaultPrompt),
    ])
    const reply = await (input.requestChat ?? requestOpenAICompatibleChat)({
      provider: providerResolution.provider,
      system: systemPrompt,
      user: buildPrompt(promptTemplate, input.message),
    })

    return {
      status: 'ok',
      source: 'model_agent',
      projectId: workspace.projectId,
      featureType: input.featureType,
      sessionId: `model-agent-${input.featureType}`,
      workspacePath: workspace.rootPath,
      reply,
    }
  } catch (error) {
    if (error instanceof ModelChatError) {
      const needsConfiguration = error.code === 'auth_error' || error.code === 'model_error'
      return failure(needsConfiguration ? 'needs_configuration' : 'agent_error', error.code, error.message)
    }
    return failure('agent_error', 'agent_error', error instanceof Error ? error.message : String(error))
  }

  function failure(status: Exclude<ModelAgentStatus, 'ok'>, code: string, message: string): RunModelAgentResult {
    return {
      status,
      source: 'model_agent',
      projectId: workspace.projectId,
      featureType: input.featureType,
      workspacePath: workspace.rootPath,
      reply: '',
      error: { code, message },
    }
  }
}

async function readPromptTemplate(promptsDir: string, promptName: string) {
  const safeName = promptName.replace(/[^a-zA-Z0-9_-]/g, '')
  return fs.readFile(path.join(promptsDir, `${safeName || 'script'}.md`), 'utf8')
}

function buildPrompt(template: string, message: string) {
  return `${template}\n\n用户输入：\n${message.trim()}`
}
