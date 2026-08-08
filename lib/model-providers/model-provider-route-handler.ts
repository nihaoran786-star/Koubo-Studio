import { NextResponse } from 'next/server'
import {
  readModelProviderSettings,
  toPublicModelProviderSettings,
  writeModelProviderSettings,
} from './model-provider-store'
import { testModelProviderConnection } from './model-provider-test-service'
import type { ModelProviderSettings, StoredModelProvider } from './model-provider-types'

export async function handleModelProvidersGet(options: {
  root?: string
} = {}) {
  try {
    const settings = await readModelProviderSettings({ root: options.root })
    return NextResponse.json({
      status: 'ok',
      source: 'model_provider_store',
      settings: toPublicModelProviderSettings(settings),
    })
  } catch (error) {
    return modelProviderError(error)
  }
}

export async function handleModelProvidersPut(request: Request, options: {
  root?: string
} = {}) {
  try {
    const current = await readModelProviderSettings({ root: options.root })
    const body = (await request.json()) as Partial<ModelProviderSettings>
    const settings = await writeModelProviderSettings(
      mergeSettings(current, body),
      { root: options.root },
    )

    return NextResponse.json({
      status: 'ok',
      source: 'model_provider_store',
      settings: toPublicModelProviderSettings(settings),
    })
  } catch (error) {
    return modelProviderError(error)
  }
}

export async function handleModelProviderTestPost(request: Request, options: {
  root?: string
  fetcher?: typeof fetch
  now?: () => Date
} = {}) {
  try {
    const settings = await readModelProviderSettings({ root: options.root })
    const body = (await request.json()) as { providerId?: string }
    const provider = settings.providers.find((item) => item.id === body.providerId)
    if (!provider) {
      return NextResponse.json(
        {
          status: 'error',
          source: 'model_provider_store',
          error: {
            code: 'invalid_provider_settings',
            message: 'Provider 不存在。',
          },
        },
        { status: 400 },
      )
    }

    const result = await testModelProviderConnection({
      provider,
      fetcher: options.fetcher,
      now: options.now,
    })
    const nextProviders = settings.providers.map((item) =>
      item.id === provider.id
        ? {
            ...item,
            status: result.status,
            lastTestedAt: result.testedAt,
            lastError: 'error' in result ? result.error : undefined,
          }
        : item,
    )
    const nextSettings = await writeModelProviderSettings(
      { ...settings, providers: nextProviders },
      { root: options.root },
    )

    return NextResponse.json(
      {
        status: result.status === 'connected' ? 'ok' : 'error',
        source: 'model_provider_test',
        result,
        settings: toPublicModelProviderSettings(nextSettings),
      },
      { status: result.status === 'connected' ? 200 : 422 },
    )
  } catch (error) {
    return modelProviderError(error)
  }
}

function mergeSettings(
  current: ModelProviderSettings,
  patch: Partial<ModelProviderSettings>,
): ModelProviderSettings {
  const providers = Array.isArray(patch.providers)
    ? current.providers.map((currentProvider) => {
        const incoming = patch.providers?.find((provider) => provider?.id === currentProvider.id)
        return incoming ? mergeProvider(currentProvider, incoming as Partial<StoredModelProvider>) : currentProvider
      })
    : current.providers

  return {
    defaultProviderId: patch.defaultProviderId ?? current.defaultProviderId,
    telemetryEnabled: patch.telemetryEnabled ?? current.telemetryEnabled,
    providers,
  }
}

function mergeProvider(
  current: StoredModelProvider,
  patch: Partial<StoredModelProvider>,
): StoredModelProvider {
  return {
    ...current,
    ...patch,
    kind: current.kind,
    id: current.id,
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey,
  }
}

function modelProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json(
    {
      status: 'error',
      source: 'model_provider_store',
      error: {
        code: 'provider_store_error',
        message,
      },
    },
    { status: 500 },
  )
}
