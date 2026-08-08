import { desktopCommandAuthErrorResponse, issueDesktopCommandToken } from '@/lib/api/desktop-command-auth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    return Response.json({ status: 'ready', source: 'desktop_command_auth', token: issueDesktopCommandToken(request) }, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    return desktopCommandAuthErrorResponse(error) ?? Response.json({
      status: 'failed', source: 'desktop_command_auth', error: { code: 'unexpected_error', message: '桌面命令初始化失败。' },
    }, { status: 500 })
  }
}
