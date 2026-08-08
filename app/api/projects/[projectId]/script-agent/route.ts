import { handleScriptAgentPatch, handleScriptAgentPost } from '@/lib/agents/script-agent-route-handler'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleScriptAgentPost(request, { projectId })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleScriptAgentPatch(request, { projectId })
}
