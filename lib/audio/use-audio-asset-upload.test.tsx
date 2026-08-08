// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAudioAssetUpload } from './use-audio-asset-upload'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useAudioAssetUpload', () => {
  it('uploads a reference file and exposes the asset', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'audio_asset',
        asset: {
          assetId: 'reference-001',
          purpose: 'reference',
          originalFilename: 'voice.wav',
          relativePath: 'files/audio/reference-001.wav',
        },
      }),
    }))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()

    render(<AudioAssetUploadProbe />)
    await user.click(screen.getByRole('button', { name: '上传参考音频' }))

    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('files/audio/reference-001.wav')).toBeInTheDocument()
  })
})

function AudioAssetUploadProbe() {
  const upload = useAudioAssetUpload('demo')

  return (
    <div>
      <span>{upload.status}</span>
      <span>{upload.lastResult?.status === 'ok' ? upload.lastResult.asset.relativePath : ''}</span>
      <button
        onClick={() =>
          upload.upload({
            purpose: 'reference',
            file: new File([new Uint8Array([1])], 'voice.wav', { type: 'audio/wav' }),
          })
        }
      >
        上传参考音频
      </button>
    </div>
  )
}
