'use client'

import { useEffect, useRef, useState } from 'react'
import {
  createAudioArtifactClient,
  statusFromLatestAudioResult,
  type LatestAudioArtifactStatus,
} from './audio-artifact-client'
import type { LatestAudioArtifactResult, SelectedAudioArtifactState } from './audio-artifact-query'

export function useLatestAudioArtifact(projectId: string, options: { scriptArtifactId?: string } = {}) {
  const [status, setStatus] = useState<LatestAudioArtifactStatus>('idle')
  const [lastResult, setLastResult] = useState<LatestAudioArtifactResult | undefined>()
  const [selected, setSelected] = useState<SelectedAudioArtifactState | undefined>()
  const selectedRef = useRef<SelectedAudioArtifactState | undefined>(undefined)

  async function reload() {
    setStatus('loading')
    const result = await createAudioArtifactClient().latest({
      projectId,
      scriptArtifactId: options.scriptArtifactId,
    })
    setLastResult(result)
    if (result.status === 'ok') {
      selectedRef.current = result.selected
      setStatus('done')
      setSelected(result.selected)
      return result
    }
    if (selectedRef.current) {
      setStatus('done')
      setSelected(selectedRef.current)
      return result
    }
    setStatus(statusFromLatestAudioResult(result))
    setSelected(undefined)
    return result
  }

  function selectFromGeneration(result: SelectedAudioArtifactState) {
    selectedRef.current = result
    setSelected(result)
    setStatus('done')
  }

  useEffect(() => {
    selectedRef.current = undefined
    setSelected(undefined)
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, options.scriptArtifactId])

  return {
    status,
    lastResult,
    selected,
    reload,
    selectFromGeneration,
  }
}
