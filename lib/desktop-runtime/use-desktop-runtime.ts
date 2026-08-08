'use client'

import { useState } from 'react'
import { createDesktopRuntimeClient } from './desktop-runtime-client'
import type { DesktopRuntimeHealthResult } from './desktop-runtime-health'

export function useDesktopRuntime(projectId?: string) {
  const [health, setHealth] = useState<DesktopRuntimeHealthResult | undefined>()
  const [checking, setChecking] = useState(false)
  const client = createDesktopRuntimeClient()

  async function checkHealth(inputProjectId = projectId) {
    if (!inputProjectId) return undefined
    setChecking(true)
    try {
      const result = await client.health({ projectId: inputProjectId })
      setHealth(result)
      return result
    } finally {
      setChecking(false)
    }
  }

  return {
    health,
    checking,
    checkHealth,
  }
}

