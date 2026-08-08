import { handleRenderArtifactFileGet } from '@/lib/digital-human/render-artifact-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  const { projectId, artifactId } = await params
  return handleRenderArtifactFileGet(request, { projectId, artifactId })
}
