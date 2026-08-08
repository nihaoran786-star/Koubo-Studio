export type ModelProviderKind =
  | 'openai'
  | 'deepseek'
  | 'local_openai_compatible'
  | 'custom_openai_compatible'

export type ModelProviderStatus =
  | 'disabled'
  | 'missing_credentials'
  | 'configured'
  | 'testing'
  | 'connected'
  | 'auth_error'
  | 'network_error'
  | 'model_error'
  | 'quota_error'
  | 'runtime_error'

export type ModelProviderDataLocation =
  | 'local_only'
  | 'cloud_provider'
  | 'configured_endpoint'
  | 'custom_endpoint'

export type ModelProviderAuthMode = 'none' | 'api_key' | 'future_oauth'

export interface ModelProviderCatalogItem {
  kind: ModelProviderKind
  name: string
  defaultBaseUrl: string
  defaultModel: string
  authMode: ModelProviderAuthMode
  requiresApiKey: boolean
  dataLocation: ModelProviderDataLocation
  note: string
}

export interface StoredModelProvider {
  id: string
  kind: ModelProviderKind
  name: string
  enabled: boolean
  baseUrl: string
  model: string
  apiKey?: string
  status: ModelProviderStatus
  lastTestedAt?: string
  lastError?: {
    code: ModelProviderStatus
    message: string
  }
}

export interface PublicModelProvider extends Omit<StoredModelProvider, 'apiKey'> {
  hasApiKey: boolean
  apiKeyPreview: string
  authMode: ModelProviderAuthMode
  requiresApiKey: boolean
  dataLocation: ModelProviderDataLocation
  note: string
}

export interface ModelProviderSettings {
  defaultProviderId: string
  telemetryEnabled: boolean
  providers: StoredModelProvider[]
}

export interface PublicModelProviderSettings {
  defaultProviderId: string
  telemetryEnabled: boolean
  providers: PublicModelProvider[]
}

export type ModelProviderStoreResult =
  | {
      status: 'ok'
      source: 'model_provider_store'
      settings: PublicModelProviderSettings
    }
  | {
      status: 'error'
      source: 'model_provider_store'
      error: {
        code: 'invalid_provider_settings' | 'provider_store_error'
        message: string
      }
    }

export type ProviderConnectionTestResult =
  | {
      status: 'connected'
      source: 'model_provider_test'
      providerId: string
      testedAt: string
    }
  | {
      status: Exclude<ModelProviderStatus, 'disabled' | 'configured' | 'testing' | 'connected'>
      source: 'model_provider_test'
      providerId: string
      testedAt: string
      error: {
        code: Exclude<ModelProviderStatus, 'disabled' | 'configured' | 'testing' | 'connected'>
        message: string
      }
    }
