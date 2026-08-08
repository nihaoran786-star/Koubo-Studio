import {
  handleRuntimeReadinessGet,
  handleRuntimeReadinessPut,
} from '@/lib/runtime-readiness/runtime-readiness-route-handler'

export const runtime = 'nodejs'

export async function GET() {
  return handleRuntimeReadinessGet()
}

export async function PUT(request: Request) {
  return handleRuntimeReadinessPut(request)
}
