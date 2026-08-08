import { handlePublishPackageGet } from '@/lib/publish/publish-package-route-handler'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; artifactId: string }> },
) {
  return handlePublishPackageGet(await params)
}
