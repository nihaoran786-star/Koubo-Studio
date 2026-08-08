'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createWindowsRuntimeClient, type WindowsRuntimeResult } from './windows-runtime-client'
import {
  createWindowsRuntimeInstallClient,
  type WindowsRuntimeInstallResult,
} from './windows-runtime-install-client'

export function useWindowsRuntime() {
  const client = useMemo(() => createWindowsRuntimeClient(), [])
  const installClient = useMemo(() => createWindowsRuntimeInstallClient(), [])
  const [result, setResult] = useState<WindowsRuntimeResult>()
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<WindowsRuntimeInstallResult>()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await client.get()
      setResult(next)
      return next
    } finally {
      setLoading(false)
    }
  }, [client])

  const installWsl = useCallback(async () => {
    setInstalling(true)
    setInstallResult(undefined)
    try {
      const next = await installClient.installWsl()
      setInstallResult(next)
      if (next.status === 'ok') await refresh()
      return next
    } finally {
      setInstalling(false)
    }
  }, [installClient, refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const wslView = useMemo(() => {
    const healthRestartRequired = result?.status === 'ok' && result.install.restartRequired
    const installRestartRequired = installResult?.status === 'ok' && installResult.restartRequired
    const restartRequired = healthRestartRequired || installRestartRequired
    const wslCheck = result?.status === 'ok'
      ? result.checks.find((check) => check.id === 'wsl')
      : undefined
    const canInstall = result?.status === 'ok'
      && !restartRequired
      && !result.install.wslInstalled
      && result.install.canInstallWsl
    const needsManualRepair = result?.status === 'ok'
      && !restartRequired
      && wslCheck !== undefined
      && wslCheck.status !== 'ready'
      && !canInstall

    return {
      restartRequired,
      canInstall,
      needsManualRepair,
    }
  }, [installResult, result])

  return {
    result,
    loading,
    installing,
    installResult,
    wslView,
    refresh,
    installWsl,
  }
}
