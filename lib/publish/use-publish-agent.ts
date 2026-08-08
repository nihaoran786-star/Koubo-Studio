'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPublishReadiness } from './browser-publish-adapter'
import {
  createPublishAgentClient,
  statusFromPublishAgentResult,
  type PublishAgentClientResult,
  type PublishAgentClientStatus,
} from './publish-agent-client'
import type { PublishAgentInput } from './publish-agent-service'

export function usePublishAgent(projectId: string) {
  const [status, setStatus] = useState<PublishAgentClientStatus>('idle')
  const [lastResult, setLastResult] = useState<PublishAgentClientResult>()
  const [health, setHealth] = useState<BrowserPublishReadiness>()
  const client = useMemo(() => createPublishAgentClient(), [])
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    setStatus('idle')
    setLastResult(undefined)
    setHealth(undefined)
  }, [projectId])

  async function checkHealth() {
    const current = generation.current
    const result = await client.health({ projectId })
    if (generation.current === current) setHealth(result)
    return result
  }

  async function load(artifactId: string) {
    const current = generation.current
    setStatus('running')
    const result = await client.load({ projectId, artifactId })
    if (generation.current === current) {
      setLastResult(result)
      setStatus(statusFromPublishAgentResult(result))
    }
    return result
  }

  async function prepare(input: { sessionId: string; input: PublishAgentInput }) {
    const current = generation.current
    setStatus('running')
    const result = await client.prepare({ projectId, sessionId: input.sessionId, input: input.input })
    if (generation.current === current) {
      setLastResult(result)
      setStatus(statusFromPublishAgentResult(result))
    }
    return result
  }

  return { status, lastResult, health, checkHealth, load, prepare }
}
