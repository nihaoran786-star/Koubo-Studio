import { handleEditMediaAssetFileGet } from '@/lib/post-production/edit-media-asset-route-handler'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; assetId: string }> }) {
  const { projectId, assetId } = await params
  return handleEditMediaAssetFileGet(request, projectId, assetId)
}
