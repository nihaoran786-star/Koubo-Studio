import { handleOpenChatCutProjectGet, handleOpenChatCutProjectPost } from '@/lib/openchatcut/route-handler'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return handleOpenChatCutProjectGet((await params).projectId)
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return handleOpenChatCutProjectPost(request, (await params).projectId)
}
