import { handleLatestAudioArtifactGet } from '@/lib/audio/audio-artifact-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleLatestAudioArtifactGet(request, { projectId })
}
