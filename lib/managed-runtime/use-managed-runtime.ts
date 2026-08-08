'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createManagedRuntimeClient, type ManagedRuntimeResult } from './managed-runtime-client'
import {
  createManagedRuntimeImportClient,
  type ManagedRuntimeActionResult,
} from './managed-runtime-import-client'

export function useManagedRuntime() {
  const client = useMemo(() => createManagedRuntimeClient(), [])
  const importClient = useMemo(() => createManagedRuntimeImportClient(), [])
  const [result, setResult] = useState<ManagedRuntimeResult>()
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [actionResult, setActionResult] = useState<ManagedRuntimeActionResult>()
  const [activeAction, setActiveAction] = useState<'import' | 'start' | 'stop' | 'uninstall'>()

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

  const importPackage = useCallback(async () => {
    setImporting(true)
    setActionResult(undefined)
    setActiveAction('import')
    try {
      const next = await importClient.importPackage()
      setActionResult(next)
      if (next.status === 'ok') await refresh()
      return next
    } finally {
      setImporting(false)
      setActiveAction(undefined)
    }
  }, [importClient, refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runLifecycle = useCallback(async (action: 'start' | 'stop' | 'uninstall') => {
    setActiveAction(action)
    setActionResult(undefined)
    try {
      const next = action === 'start'
        ? await importClient.startRuntime()
        : action === 'stop'
          ? await importClient.stopRuntime()
          : await importClient.uninstallRuntime()
      setActionResult(next)
      if (next.status === 'ok') await refresh()
      return next
    } finally {
      setActiveAction(undefined)
    }
  }, [importClient, refresh])

  return {
    result, loading, importing, activeAction, actionResult, refresh, importPackage,
    startRuntime: () => runLifecycle('start'),
    stopRuntime: () => runLifecycle('stop'),
    uninstallRuntime: () => runLifecycle('uninstall'),
  }
}
