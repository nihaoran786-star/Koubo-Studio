import { handleIndexTTS2Get, handleIndexTTS2Post } from '@/lib/audio/indextts2-route-handler'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleIndexTTS2Get(request, { projectId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleIndexTTS2Post(request, { projectId })
}
