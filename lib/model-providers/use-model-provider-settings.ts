'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchModelProviderSettings,
  saveModelProviderSettings,
  testModelProvider,
} from './model-provider-client'
import type { PublicModelProvider, PublicModelProviderSettings } from './model-provider-types'

export type UseModelProviderSettingsStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'testing'
  | 'error'

export type EditableModelProvider = PublicModelProvider & {
  apiKeyInput: string
}

export interface EditableModelProviderSettings
  extends Omit<PublicModelProviderSettings, 'providers'> {
  providers: EditableModelProvider[]
}

export function useModelProviderSettings() {
  const [status, setStatus] = useState<UseModelProviderSettingsStatus>('idle')
  const [settings, setSettings] = useState<EditableModelProviderSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    setError(null)
    const result = await fetchModelProviderSettings()
    if (result.status === 'ok' && result.settings) {
      setSettings(toEditableSettings(result.settings))
      setStatus('ready')
      return
    }
    setError(result.error?.message ?? '模型 Provider 设置加载失败。')
    setStatus('error')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const updateProviderDraft = useCallback((providerId: string, patch: Partial<EditableModelProvider>) => {
    setSettings((current) => {
      if (!current) return current
      return {
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === providerId ? { ...provider, ...patch } : provider,
        ),
      }
    })
  }, [])

  const saveProvider = useCallback(async (providerId: string) => {
    if (!settings) return
    const provider = settings.providers.find((item) => item.id === providerId)
    if (!provider) return
    setStatus('saving')
    setError(null)
    const result = await saveModelProviderSettings({
      providers: [
        {
          id: provider.id,
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          model: provider.model,
          apiKey: provider.apiKeyInput.trim() ? provider.apiKeyInput : undefined,
        },
      ],
    })
    applySettingsResult(result.settings, result.error?.message)
  }, [settings])

  const selectDefaultProvider = useCallback(async (providerId: string) => {
    setStatus('saving')
    setError(null)
    const result = await saveModelProviderSettings({ defaultProviderId: providerId })
    applySettingsResult(result.settings, result.error?.message)
  }, [])

  const toggleTelemetry = useCallback(async () => {
    if (!settings) return
    setStatus('saving')
    setError(null)
    const result = await saveModelProviderSettings({
      telemetryEnabled: !settings.telemetryEnabled,
    })
    applySettingsResult(result.settings, result.error?.message)
  }, [settings])

  const runProviderTest = useCallback(async (providerId: string) => {
    await saveProvider(providerId)
    setStatus('testing')
    setError(null)
    const result = await testModelProvider(providerId)
    if (result.settings) {
      setSettings(toEditableSettings(result.settings))
    }
    if (result.status === 'ok') {
      setStatus('ready')
      return
    }
    setError(result.result?.error?.message ?? result.error?.message ?? 'Provider 连接测试失败。')
    setStatus('ready')
  }, [saveProvider])

  const busy = status === 'loading' || status === 'saving' || status === 'testing'

  return useMemo(() => ({
    status,
    busy,
    settings,
    error,
    reload: load,
    updateProviderDraft,
    saveProvider,
    selectDefaultProvider,
    toggleTelemetry,
    runProviderTest,
  }), [
    status,
    busy,
    settings,
    error,
    load,
    updateProviderDraft,
    saveProvider,
    selectDefaultProvider,
    toggleTelemetry,
    runProviderTest,
  ])

  function applySettingsResult(nextSettings: PublicModelProviderSettings | undefined, message: string | undefined) {
    if (nextSettings) {
      setSettings(toEditableSettings(nextSettings))
      setStatus('ready')
      return
    }
    setError(message ?? '模型 Provider 设置保存失败。')
    setStatus('error')
  }
}

function toEditableSettings(settings: PublicModelProviderSettings): EditableModelProviderSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => ({
      ...provider,
      apiKeyInput: '',
    })),
  }
}
