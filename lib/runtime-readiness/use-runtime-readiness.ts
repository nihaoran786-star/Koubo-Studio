'use client'

import { useEffect, useMemo, useState } from 'react'
import { createRuntimeReadinessClient } from './runtime-readiness-client'
import type { LocalRuntimeConfigPatch } from '@/lib/runtime-data/runtime-config-store'
import type { RuntimeReadinessApiResult, RuntimeReadinessProfileId } from './runtime-readiness-types'

export function useRuntimeReadiness() {
  const client = useMemo(() => createRuntimeReadinessClient(), [])
  const [result, setResult] = useState<RuntimeReadinessApiResult | undefined>()
  const [loading, setLoading] = useState(true)

  async function refresh() {
    setLoading(true)
    try {
      const next = await client.get()
      setResult(next)
      return next
    } finally {
      setLoading(false)
    }
  }

  async function updateProfile(profileId: RuntimeReadinessProfileId) {
    setLoading(true)
    try {
      const next = await client.updateProfile(profileId)
      setResult(next)
      return next
    } finally {
      setLoading(false)
    }
  }

  async function updateLocalRuntimeConfig(localRuntimeConfig: LocalRuntimeConfigPatch) {
    setLoading(true)
    try {
      const next = await client.updateLocalRuntimeConfig(localRuntimeConfig)
      setResult(next)
      return next
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  return {
    result,
    loading,
    refresh,
    updateProfile,
    updateLocalRuntimeConfig,
  }
}
