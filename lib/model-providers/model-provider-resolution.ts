import type { ModelProviderKind, ModelProviderSettings, StoredModelProvider } from './model-provider-types'
import { readModelProviderSettings } from './model-provider-store'

export type ModelProviderResolutionStatus =
  | 'ok'
  | 'no_default_provider'
  | 'provider_disabled'
  | 'missing_credentials'
  | 'unsupported_provider'
  | 'runtime_error'

export interface ResolvedModelProvider {
  providerId: string
  providerKind: ModelProviderKind
  modelId: string
  baseUrl: string
  apiKey?: string
  authHeader: boolean
}

export type ModelProviderResolutionResult =
  | {
      status: 'ok'
      source: 'model_provider_resolution'
      provider: ResolvedModelProvider
    }
  | {
      status: Exclude<ModelProviderResolutionStatus, 'ok'>
      source: 'model_provider_resolution'
      error: {
        code: Exclude<ModelProviderResolutionStatus, 'ok'>
        message: string
      }
    }

export async function resolveDefaultModelProvider(options: {
  root?: string
  readSettings?: () => Promise<ModelProviderSettings>
} = {}): Promise<ModelProviderResolutionResult> {
  try {
    const settings = await (options.readSettings ?? (() => readModelProviderSettings({ root: options.root })))()
    return resolveModelProviderFromSettings(settings)
  } catch (error) {
    return {
      status: 'runtime_error',
      source: 'model_provider_resolution',
      error: {
        code: 'runtime_error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export function resolveModelProviderFromSettings(settings: ModelProviderSettings): ModelProviderResolutionResult {
  const provider = settings.providers.find((item) => item.id === settings.defaultProviderId)
  if (!provider) {
    return resolutionError('no_default_provider', '未找到默认模型 Provider。请先在设置页选择默认 Provider。')
  }

  return resolveStoredModelProvider(provider)
}

export function resolveStoredModelProvider(provider: StoredModelProvider): ModelProviderResolutionResult {
  if (!provider.enabled) {
    return resolutionError('provider_disabled', `默认 Provider「${provider.name}」已停用。`)
  }

  if (!isSupportedOpenAICompatibleProvider(provider.kind)) {
    return resolutionError('unsupported_provider', `暂不支持的 Provider 类型：${provider.kind}`)
  }

  const baseUrl = provider.baseUrl.trim()
  const modelId = provider.model.trim()
  if (!baseUrl || !modelId) {
    return resolutionError('missing_credentials', `Provider「${provider.name}」缺少 Base URL 或模型名。`)
  }

  const requiresApiKey = provider.kind === 'openai' || provider.kind === 'deepseek'
  const apiKey = provider.apiKey?.trim()
  if (requiresApiKey && !apiKey) {
    return resolutionError('missing_credentials', `Provider「${provider.name}」需要 API Key。`)
  }

  return {
    status: 'ok',
    source: 'model_provider_resolution',
    provider: {
      providerId: provider.id,
      providerKind: provider.kind,
      modelId,
      baseUrl,
      apiKey: apiKey || undefined,
      authHeader: Boolean(apiKey),
    },
  }
}

function isSupportedOpenAICompatibleProvider(kind: ModelProviderKind) {
  return (
    kind === 'openai' ||
    kind === 'deepseek' ||
    kind === 'local_openai_compatible' ||
    kind === 'custom_openai_compatible'
  )
}

function resolutionError(
  code: Exclude<ModelProviderResolutionStatus, 'ok'>,
  message: string,
): ModelProviderResolutionResult {
  return {
    status: code,
    source: 'model_provider_resolution',
    error: {
      code,
      message,
    },
  }
}
