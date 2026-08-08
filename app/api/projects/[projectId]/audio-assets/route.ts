import { handleAudioAssetGet, handleAudioAssetPost } from '@/lib/audio/audio-asset-route-handler'
import { rejectUntrustedApiWrite } from '@/lib/api/api-cors'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const rejected = rejectUntrustedApiWrite(request)
  if (rejected) return rejected
  const { projectId } = await params
  return handleAudioAssetPost(request, { projectId })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleAudioAssetGet({ projectId })
}
