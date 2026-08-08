import { getModelProviderCatalogItem } from './model-provider-catalog'
import type {
  ModelProviderStatus,
  ProviderConnectionTestResult,
  StoredModelProvider,
} from './model-provider-types'

type Fetcher = typeof fetch

export async function testModelProviderConnection(options: {
  provider: StoredModelProvider
  fetcher?: Fetcher
  now?: () => Date
  timeoutMs?: number
}): Promise<ProviderConnectionTestResult> {
  const provider = options.provider
  const testedAt = (options.now ?? (() => new Date()))().toISOString()
  const catalog = getModelProviderCatalogItem(provider.kind)

  if (!provider.enabled) {
    return failed(provider.id, testedAt, 'missing_credentials', 'Provider 尚未启用。')
  }
  if (!provider.baseUrl.trim() || !provider.model.trim()) {
    return failed(provider.id, testedAt, 'missing_credentials', '缺少 Base URL 或模型名。')
  }
  if (catalog.requiresApiKey && !provider.apiKey?.trim()) {
    return failed(provider.id, testedAt, 'missing_credentials', '该 Provider 需要 API Key。')
  }

  let endpoint: URL
  try {
    endpoint = new URL(`${normalizeBaseUrl(provider.baseUrl)}/models`)
  } catch {
    return failed(provider.id, testedAt, 'runtime_error', 'Base URL 不是有效 URL。')
  }

  const abortController = new AbortController()
  const timeout = setTimeout(
    () => abortController.abort(new Error('provider_probe_timeout')),
    Math.max(1, options.timeoutMs ?? 3000),
  )

  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: 'GET',
      signal: abortController.signal,
      headers: {
        ...(provider.apiKey?.trim() ? { Authorization: `Bearer ${provider.apiKey.trim()}` } : {}),
      },
    })

    if (response.status === 401 || response.status === 403) {
      return failed(provider.id, testedAt, 'auth_error', 'API Key 无效或没有访问权限。')
    }
    if (response.status === 404) {
      return failed(provider.id, testedAt, 'model_error', 'Provider 不支持 /models 检查或模型地址错误。')
    }
    if (response.status === 429) {
      return failed(provider.id, testedAt, 'quota_error', 'Provider 配额不足或请求过于频繁。')
    }
    if (!response.ok) {
      return failed(provider.id, testedAt, 'runtime_error', `Provider 返回 HTTP ${response.status}。`)
    }

    return {
      status: 'connected',
      source: 'model_provider_test',
      providerId: provider.id,
      testedAt,
    }
  } catch {
    if (abortController.signal.aborted) {
      return failed(provider.id, testedAt, 'network_error', '连接 Provider 超时，请检查服务是否已启动。')
    }
    return failed(provider.id, testedAt, 'network_error', '无法连接 Provider，请检查网络、Base URL 或本地服务。')
  } finally {
    clearTimeout(timeout)
  }
}

function failed(
  providerId: string,
  testedAt: string,
  code: Exclude<ModelProviderStatus, 'disabled' | 'configured' | 'testing' | 'connected'>,
  message: string,
): ProviderConnectionTestResult {
  return {
    status: code,
    source: 'model_provider_test',
    providerId,
    testedAt,
    error: {
      code,
      message,
    },
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '')
}
