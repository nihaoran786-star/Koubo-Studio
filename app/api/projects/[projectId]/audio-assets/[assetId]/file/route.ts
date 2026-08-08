import { handleAudioAssetFileGet } from '@/lib/audio/audio-asset-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; assetId: string }> },
) {
  const { projectId, assetId } = await params
  return handleAudioAssetFileGet(request, { projectId, assetId })
}
