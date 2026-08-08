import { handlePostProductionAgentGet, handlePostProductionAgentPost } from '@/lib/post-production/post-production-agent-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePostProductionAgentGet(request, { projectId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePostProductionAgentPost(request, { projectId })
}
