import type {
  PublicModelProviderSettings,
  StoredModelProvider,
} from './model-provider-types'

export type ModelProviderClientStatus = 'ok' | 'error'

export interface ModelProviderSettingsResponse {
  status: ModelProviderClientStatus
  source: 'model_provider_store'
  settings?: PublicModelProviderSettings
  error?: {
    code: 'desktop_backend_missing' | 'provider_store_error' | 'invalid_provider_settings'
    message: string
  }
}

export interface ModelProviderTestResponse {
  status: ModelProviderClientStatus
  source: 'model_provider_test' | 'model_provider_store'
  result?: {
    status: string
    providerId: string
    testedAt: string
    error?: {
      code: string
      message: string
    }
  }
  settings?: PublicModelProviderSettings
  error?: {
    code: string
    message: string
  }
}

type Fetcher = typeof fetch

const MODEL_PROVIDERS_ENDPOINT = '/api/settings/model-providers'

export async function fetchModelProviderSettings(options: {
  fetcher?: Fetcher
} = {}): Promise<ModelProviderSettingsResponse> {
  return requestModelProviderJson<ModelProviderSettingsResponse>(MODEL_PROVIDERS_ENDPOINT, {
    fetcher: options.fetcher,
  })
}

export async function saveModelProviderSettings(
  patch: {
    defaultProviderId?: string
    telemetryEnabled?: boolean
    providers?: Array<Partial<StoredModelProvider> & { id: string }>
  },
  options: { fetcher?: Fetcher } = {},
): Promise<ModelProviderSettingsResponse> {
  return requestModelProviderJson<ModelProviderSettingsResponse>(MODEL_PROVIDERS_ENDPOINT, {
    fetcher: options.fetcher,
    init: {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(patch),
    },
  })
}

export async function testModelProvider(
  providerId: string,
  options: { fetcher?: Fetcher } = {},
): Promise<ModelProviderTestResponse> {
  return requestModelProviderJson<ModelProviderTestResponse>(MODEL_PROVIDERS_ENDPOINT, {
    fetcher: options.fetcher,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ providerId }),
    },
  })
}

async function requestModelProviderJson<T>(
  input: RequestInfo | URL,
  options: {
    fetcher?: Fetcher
    init?: RequestInit
  } = {},
): Promise<T> {
  try {
    const response = await (options.fetcher ?? fetch)(input, options.init)
    return (await response.json()) as T
  } catch {
    return {
      status: 'error',
      source: 'model_provider_store',
      error: {
        code: 'desktop_backend_missing',
        message: '无法连接设置后端。桌面端生产包需要 local backend 或 sidecar 承载 API。',
      },
    } as T
  }
}
