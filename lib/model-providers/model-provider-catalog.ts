import type { ModelProviderCatalogItem, ModelProviderKind } from './model-provider-types'

export const MODEL_PROVIDER_CATALOG: ModelProviderCatalogItem[] = [
  {
    kind: 'openai',
    name: 'OpenAI API',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    authMode: 'api_key',
    requiresApiKey: true,
    dataLocation: 'cloud_provider',
    note: '使用 OpenAI API Key。ChatGPT 订阅登录不等同于 API 凭据。',
  },
  {
    kind: 'deepseek',
    name: 'DeepSeek API',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    authMode: 'api_key',
    requiresApiKey: true,
    dataLocation: 'cloud_provider',
    note: '使用 DeepSeek API Key，接口按 OpenAI-compatible 方式测试。',
  },
  {
    kind: 'local_openai_compatible',
    name: '本地 OpenAI-compatible',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5',
    authMode: 'none',
    requiresApiKey: false,
    dataLocation: 'local_only',
    note: '适合 Ollama、LM Studio 等本地兼容服务，文本默认不离开本机。',
  },
  {
    kind: 'custom_openai_compatible',
    name: '自定义 OpenAI-compatible',
    defaultBaseUrl: '',
    defaultModel: '',
    authMode: 'api_key',
    requiresApiKey: false,
    dataLocation: 'custom_endpoint',
    note: '适合私有网关或第三方兼容接口，数据策略由用户配置的 endpoint 决定。',
  },
]

export function getModelProviderCatalogItem(kind: ModelProviderKind) {
  const item = MODEL_PROVIDER_CATALOG.find((provider) => provider.kind === kind)
  if (!item) {
    throw new ModelProviderCatalogError(`不支持的模型 Provider：${kind}`)
  }
  return item
}

export class ModelProviderCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelProviderCatalogError'
  }
}
