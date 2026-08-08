import fs from 'node:fs/promises'
import path from 'node:path'
import { MODEL_PROVIDER_CATALOG, getModelProviderCatalogItem } from './model-provider-catalog'
import type {
  ModelProviderSettings,
  PublicModelProvider,
  PublicModelProviderSettings,
  StoredModelProvider,
} from './model-provider-types'
import { getRuntimeSettingsRoot } from '@/lib/runtime-data/runtime-data-root'

const SETTINGS_FILE = 'model-providers.json'

export function createDefaultModelProviderSettings(): ModelProviderSettings {
  const providers = MODEL_PROVIDER_CATALOG.map((item) => ({
    id: item.kind,
    kind: item.kind,
    name: item.name,
    enabled: item.kind === 'deepseek',
    baseUrl: item.defaultBaseUrl,
    model: item.defaultModel,
    apiKey: '',
    status: item.kind === 'deepseek' ? 'missing_credentials' : 'disabled',
  }) satisfies StoredModelProvider)

  return {
    defaultProviderId: 'deepseek',
    telemetryEnabled: false,
    providers,
  }
}

export async function readModelProviderSettings(options: {
  root?: string
} = {}): Promise<ModelProviderSettings> {
  const filePath = settingsPath(options.root)

  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<ModelProviderSettings>)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createDefaultModelProviderSettings()
    }
    throw new ModelProviderStoreError('模型 Provider 设置无法读取或解析')
  }
}

export async function writeModelProviderSettings(
  settings: ModelProviderSettings,
  options: { root?: string } = {},
): Promise<ModelProviderSettings> {
  const normalized = normalizeSettings(settings)
  const filePath = settingsPath(options.root)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

export async function updateModelProviderSettings(
  patch: Partial<ModelProviderSettings>,
  options: { root?: string } = {},
): Promise<ModelProviderSettings> {
  const current = await readModelProviderSettings(options)
  return writeModelProviderSettings(
    {
      ...current,
      ...patch,
      providers: patch.providers ?? current.providers,
    },
    options,
  )
}

export function toPublicModelProviderSettings(
  settings: ModelProviderSettings,
): PublicModelProviderSettings {
  return {
    defaultProviderId: settings.defaultProviderId,
    telemetryEnabled: settings.telemetryEnabled,
    providers: settings.providers.map(toPublicModelProvider),
  }
}

export function toPublicModelProvider(provider: StoredModelProvider): PublicModelProvider {
  const catalog = getModelProviderCatalogItem(provider.kind)
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    model: provider.model,
    status: provider.status,
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError,
    hasApiKey: Boolean(provider.apiKey?.trim()),
    apiKeyPreview: previewSecret(provider.apiKey),
    authMode: catalog.authMode,
    requiresApiKey: catalog.requiresApiKey,
    dataLocation: catalog.dataLocation,
    note: catalog.note,
  }
}

function normalizeSettings(settings: Partial<ModelProviderSettings>): ModelProviderSettings {
  const defaults = createDefaultModelProviderSettings()
  const incomingProviders = Array.isArray(settings.providers) ? settings.providers : []
  const providers = defaults.providers.map((defaultProvider) => {
    const incoming = incomingProviders.find((provider) => provider?.id === defaultProvider.id)
    return normalizeProvider({ ...defaultProvider, ...incoming })
  })
  const requestedDefaultProviderId = settings.defaultProviderId
  const defaultProviderId: string = providers.some((provider) => provider.id === requestedDefaultProviderId)
    ? String(requestedDefaultProviderId)
    : defaults.defaultProviderId

  return {
    defaultProviderId,
    telemetryEnabled: Boolean(settings.telemetryEnabled),
    providers,
  }
}

function normalizeProvider(provider: StoredModelProvider): StoredModelProvider {
  const catalog = getModelProviderCatalogItem(provider.kind)
  const baseUrl = provider.baseUrl?.trim() ?? ''
  const model = provider.model?.trim() ?? ''
  const apiKey = provider.apiKey ?? ''
  const enabled = Boolean(provider.enabled)

  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name || catalog.name,
    enabled,
    baseUrl,
    model,
    apiKey,
    status: normalizeStatus({ provider: { ...provider, enabled, baseUrl, model, apiKey } }),
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError,
  }
}

function normalizeStatus({ provider }: { provider: StoredModelProvider }) {
  const catalog = getModelProviderCatalogItem(provider.kind)
  if (!provider.enabled) return 'disabled'
  if (!provider.baseUrl || !provider.model) return 'missing_credentials'
  if (catalog.requiresApiKey && !provider.apiKey?.trim()) return 'missing_credentials'
  if (
    provider.status === 'connected' ||
    provider.status === 'auth_error' ||
    provider.status === 'network_error' ||
    provider.status === 'model_error' ||
    provider.status === 'quota_error' ||
    provider.status === 'runtime_error'
  ) {
    return provider.status
  }
  return 'configured'
}

function previewSecret(secret: string | undefined) {
  const trimmed = secret?.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return '********'
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

function settingsPath(root = getRuntimeSettingsRoot()) {
  return path.join(root, SETTINGS_FILE)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export class ModelProviderStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelProviderStoreError'
  }
}
