import {
  handlePublishAgentPatch,
  handlePublishAgentGet,
  handlePublishAgentPost,
  handlePublishAgentPut,
} from '@/lib/publish/publish-agent-route-handler'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePublishAgentGet({ projectId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePublishAgentPost(request, { projectId })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePublishAgentPut(request, { projectId })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handlePublishAgentPatch(request, { projectId })
}
