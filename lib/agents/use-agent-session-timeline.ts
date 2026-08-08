'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  createAgentSessionTimelineClient,
  type AgentSessionTimelineClientResult,
} from './agent-session-timeline-client'

export function useAgentSessionTimeline(projectId?: string) {
  const client = useMemo(() => createAgentSessionTimelineClient(), [])
  const [result, setResult] = useState<AgentSessionTimelineClientResult | undefined>()
  const [loading, setLoading] = useState(false)

  async function refresh(inputProjectId = projectId) {
    if (!inputProjectId) return undefined
    setLoading(true)
    try {
      const next = await client({ projectId: inputProjectId })
      setResult(next)
      return next
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(projectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return {
    result,
    loading,
    refresh,
  }
}
