import { handleAudioArtifactFileGet } from '@/lib/audio/audio-artifact-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  const { projectId, artifactId } = await params
  return handleAudioArtifactFileGet(request, { projectId, artifactId })
}
