import { handleManagedRuntimeGet } from '@/lib/managed-runtime/managed-runtime-route-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return handleManagedRuntimeGet()
}

