import { NextResponse, type NextRequest } from 'next/server'
import { corsHeadersForRequest, rejectUntrustedApiWrite } from '@/lib/api/api-cors'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function proxy(request: NextRequest) {
  const corsHeaders = corsHeadersForRequest(request.headers.get('origin'))

  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: Object.keys(corsHeaders).length > 0 ? 204 : 403,
      headers: corsHeaders,
    })
  }

  if (!SAFE_METHODS.has(request.method)) {
    const rejected = rejectUntrustedApiWrite(request)
    if (rejected) return rejected
  }

  const response = NextResponse.next()
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value)
  }
  return response
}

export const config = {
  // Raw media upload routes enforce the same origin check in their route
  // handlers. Keeping them out of Proxy avoids Next buffering/truncating the
  // request body at 10 MiB, so uploads remain genuinely streamed to disk.
  matcher: '/api/((?!projects/[^/]+/(?:audio-assets|avatar-assets|edit-media-assets)/?$).*)',
}
