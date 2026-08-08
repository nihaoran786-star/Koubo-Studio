import { handlePostProductionArtifactFileGet } from '@/lib/post-production/post-production-artifact-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  const { projectId, artifactId } = await params
  return handlePostProductionArtifactFileGet(request, { projectId, artifactId })
}
