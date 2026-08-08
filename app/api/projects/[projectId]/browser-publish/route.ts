import {
  handleBrowserPublishDelete,
  handleBrowserPublishGet,
  handleBrowserPublishPatch,
  handleBrowserPublishPost,
} from '@/lib/publish/browser-publish-route-handler'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ projectId: string }> }

export async function GET(request: Request, { params }: RouteContext) {
  return handleBrowserPublishGet(request, (await params).projectId)
}

export async function POST(request: Request, { params }: RouteContext) {
  return handleBrowserPublishPost(request, (await params).projectId)
}

export async function PATCH(request: Request, { params }: RouteContext) {
  return handleBrowserPublishPatch(request, (await params).projectId)
}

export async function DELETE(request: Request, { params }: RouteContext) {
  return handleBrowserPublishDelete(request, (await params).projectId)
}
