import { handleDesktopRuntimeGet } from '@/lib/desktop-runtime/desktop-runtime-route-handler'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params
  return handleDesktopRuntimeGet({ projectId })
}

