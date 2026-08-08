'use client'

import { useState } from 'react'
import {
  createAvatarAssetClient,
  statusFromAvatarAssetResult,
  type AvatarAssetClientResult,
  type AvatarAssetClientStatus,
} from './avatar-asset-client'

export function useAvatarAssetUpload(projectId: string) {
  const [status, setStatus] = useState<AvatarAssetClientStatus>('idle')
  const [lastResult, setLastResult] = useState<AvatarAssetClientResult | undefined>()
  const client = createAvatarAssetClient()

  async function upload(input: { file: File }) {
    setStatus('uploading')
    const result = await client({
      projectId,
      file: input.file,
    })
    setLastResult(result)
    setStatus(statusFromAvatarAssetResult(result))
    return result
  }

  return {
    status,
    lastResult,
    upload,
  }
}
