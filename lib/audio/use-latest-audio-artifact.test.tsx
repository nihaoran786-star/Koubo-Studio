// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLatestAudioArtifact } from './use-latest-audio-artifact'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useLatestAudioArtifact', () => {
  it('loads and exposes the latest ready audio artifact', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'audio_artifact_query',
        selected: {
          artifactId: 'audio-001',
          durationSeconds: 8.2,
          playbackUrl: '/api/projects/demo/audio-artifacts/audio-001/file',
        },
      }),
    }))
    vi.stubGlobal('fetch', fetcher)

    render(<LatestAudioProbe />)

    expect(screen.getByText('loading')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('audio-001')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/demo/audio-artifacts/latest?scriptArtifactId=script-001',
      undefined,
    )
  })
})

function LatestAudioProbe() {
  const latest = useLatestAudioArtifact('demo', { scriptArtifactId: 'script-001' })

  return (
    <div>
      <span>{latest.status}</span>
      <span>{latest.selected?.artifactId}</span>
    </div>
  )
}
