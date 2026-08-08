import {
  handleModelProviderTestPost,
  handleModelProvidersGet,
  handleModelProvidersPut,
} from '@/lib/model-providers/model-provider-route-handler'

export const runtime = 'nodejs'

export async function GET() {
  return handleModelProvidersGet()
}

export async function PUT(request: Request) {
  return handleModelProvidersPut(request)
}

export async function POST(request: Request) {
  return handleModelProviderTestPost(request)
}
