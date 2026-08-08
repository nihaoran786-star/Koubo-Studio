import { handleProjectStateGet, handleProjectStatePatch } from '@/lib/project-state/project-state-route-handler'

export const runtime = 'nodejs'
export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleProjectStateGet(await params)
}
export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleProjectStatePatch(request, await params)
}
