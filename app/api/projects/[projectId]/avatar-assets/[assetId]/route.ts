import { handleAvatarAssetDelete } from '@/lib/digital-human/avatar-asset-route-handler'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; assetId: string }> },
) {
  const { projectId, assetId } = await params
  return handleAvatarAssetDelete({ projectId, assetId })
}
