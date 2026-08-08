const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i
const TAURI_ORIGIN_PATTERN = /^https?:\/\/tauri\.localhost(?::\d+)?$/i

export function corsOriginForRequest(origin: string | null) {
  if (!origin) return '*'
  if (origin === 'null') return '*'
  if (LOCAL_ORIGIN_PATTERN.test(origin)) return origin
  if (TAURI_ORIGIN_PATTERN.test(origin)) return origin
  return ''
}

export function corsHeadersForRequest(origin: string | null): Record<string, string> {
  const allowedOrigin = corsOriginForRequest(origin)
  if (!allowedOrigin) return {}

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function isTrustedApiWriteOrigin(origin: string | null) {
  // Native desktop calls and local smoke scripts may omit Origin. Browsers do
  // send it for cross-origin writes, which lets the loopback API reject CSRF.
  if (!origin) return true
  return Boolean(corsOriginForRequest(origin)) && origin !== 'null'
}

export function rejectUntrustedApiWrite(request: Request) {
  if (isTrustedApiWriteOrigin(request.headers.get('origin'))) return undefined
  return Response.json({
    status: 'forbidden',
    source: 'loopback_api',
    error: {
      code: 'untrusted_origin',
      message: '已阻止非本机页面调用桌面写入接口。',
    },
  }, { status: 403 })
}
