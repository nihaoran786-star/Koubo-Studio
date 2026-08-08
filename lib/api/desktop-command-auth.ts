import { timingSafeEqual } from 'node:crypto'

export type DesktopCommandAuthErrorCode =
  | 'desktop_command_unavailable'
  | 'untrusted_host'
  | 'untrusted_origin'
  | 'invalid_desktop_token'

export class DesktopCommandAuthError extends Error {
  constructor(public readonly code: DesktopCommandAuthErrorCode, message: string) {
    super(message)
    this.name = 'DesktopCommandAuthError'
  }
}

type DesktopCommandEnv = {
  KOUBO_DESKTOP_API_TOKEN?: string
  KOUBO_BACKEND_PORT?: string
  PORT?: string
}

export function authorizeDesktopCommand(request: Request, env: DesktopCommandEnv = process.env as DesktopCommandEnv) {
  const token = readDesktopToken(env)
  assertTrustedLoopbackRequest(request, env)
  const candidate = request.headers.get('x-koubo-desktop-token') ?? ''
  if (!constantTimeEqual(candidate, token)) {
    throw new DesktopCommandAuthError('invalid_desktop_token', '桌面命令凭证无效，请重新打开应用。')
  }
}

export function issueDesktopCommandToken(request: Request, env: DesktopCommandEnv = process.env as DesktopCommandEnv) {
  const token = readDesktopToken(env)
  assertTrustedLoopbackRequest(request, env)
  return token
}

export function desktopCommandAuthErrorResponse(error: unknown) {
  if (!(error instanceof DesktopCommandAuthError)) return undefined
  const status = error.code === 'desktop_command_unavailable' ? 503 : 403
  return Response.json({
    status: 'forbidden',
    source: 'desktop_command_auth',
    error: { code: error.code, message: error.message },
  }, { status })
}

function readDesktopToken(env: DesktopCommandEnv) {
  const token = env.KOUBO_DESKTOP_API_TOKEN?.trim()
  if (!token || token.length < 24) {
    throw new DesktopCommandAuthError('desktop_command_unavailable', '当前不是受保护的桌面运行环境。')
  }
  return token
}

function assertTrustedLoopbackRequest(request: Request, env: DesktopCommandEnv) {
  const expectedPort = env.KOUBO_BACKEND_PORT || env.PORT || '3100'
  const url = new URL(request.url)
  const host = request.headers.get('host') || url.host
  if (host !== `127.0.0.1:${expectedPort}` && host !== `localhost:${expectedPort}`) {
    throw new DesktopCommandAuthError('untrusted_host', '桌面命令只接受本机应用请求。')
  }

  const origin = request.headers.get('origin') || originFromReferer(request.headers.get('referer'))
  const expectedOrigins = new Set([`http://127.0.0.1:${expectedPort}`, `http://localhost:${expectedPort}`])
  if (!origin || !expectedOrigins.has(origin)) {
    throw new DesktopCommandAuthError('untrusted_origin', '桌面命令只接受当前应用页面请求。')
  }

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new DesktopCommandAuthError('untrusted_origin', '桌面命令已拒绝跨站请求。')
  }
}

function originFromReferer(referer: string | null) {
  if (!referer) return undefined
  try {
    return new URL(referer).origin
  } catch {
    return undefined
  }
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
