import { authorizeDesktopCommand, desktopCommandAuthErrorResponse } from '@/lib/api/desktop-command-auth'
import { getBrowserPublishService } from '@/lib/publish/browser'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    authorizeDesktopCommand(request)
    await getBrowserPublishService().close()
    return Response.json({ status: 'closed', source: 'desktop_runtime' })
  } catch (error) {
    return desktopCommandAuthErrorResponse(error) ?? Response.json({
      status: 'failed', source: 'desktop_runtime', error: { code: 'shutdown_failed', message: '桌面运行时关闭失败。' },
    }, { status: 500 })
  }
}
