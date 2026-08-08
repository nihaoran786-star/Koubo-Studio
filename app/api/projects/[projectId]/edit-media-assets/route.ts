import { handleEditMediaAssetGet, handleEditMediaAssetPost } from '@/lib/post-production/edit-media-asset-route-handler'
import { rejectUntrustedApiWrite } from '@/lib/api/api-cors'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleEditMediaAssetGet(request, (await params).projectId)
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const rejected = rejectUntrustedApiWrite(request)
  if (rejected) return rejected
  return handleEditMediaAssetPost(request, (await params).projectId)
}
