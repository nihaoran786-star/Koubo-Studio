'use client'

import { useState } from 'react'
import {
  createAudioAssetClient,
  statusFromAudioAssetResult,
  type AudioAssetClientResult,
  type AudioAssetClientStatus,
} from './audio-asset-client'
import type { AudioAssetPurpose } from './audio-asset'

export function useAudioAssetUpload(projectId: string) {
  const [status, setStatus] = useState<AudioAssetClientStatus>('idle')
  const [lastResult, setLastResult] = useState<AudioAssetClientResult | undefined>()
  const client = createAudioAssetClient()

  async function upload(input: {
    purpose: AudioAssetPurpose
    file: File
  }) {
    setStatus('uploading')
    const result = await client({
      projectId,
      purpose: input.purpose,
      file: input.file,
    })
    setLastResult(result)
    setStatus(statusFromAudioAssetResult(result))
    return result
  }

  return {
    status,
    lastResult,
    upload,
  }
}
