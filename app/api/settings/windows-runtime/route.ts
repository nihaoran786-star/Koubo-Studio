import { handleWindowsRuntimeGet } from '@/lib/windows-runtime/windows-runtime-route-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handleWindowsRuntimeGet()
}
