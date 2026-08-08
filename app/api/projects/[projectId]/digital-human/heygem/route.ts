import { handleHeyGemGet, handleHeyGemPost } from '@/lib/digital-human/heygem-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleHeyGemGet(request, { projectId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleHeyGemPost(request, { projectId })
}
