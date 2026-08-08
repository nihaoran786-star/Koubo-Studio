import { desktopCommandAuthErrorResponse, authorizeDesktopCommand } from '@/lib/api/desktop-command-auth'
import { isPublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import {
  getBrowserPublishService,
  type BrowserPublishSnapshot,
  type BrowserPublishTarget,
} from './browser'

type BrowserPublishServiceLike = {
  getSnapshot(): BrowserPublishSnapshot
  open(target: BrowserPublishTarget): Promise<BrowserPublishSnapshot>
  refresh(): Promise<BrowserPublishSnapshot>
  fill(target?: BrowserPublishTarget): Promise<BrowserPublishSnapshot>
  close(): Promise<BrowserPublishSnapshot>
}

export async function handleBrowserPublishGet(request: Request, projectId: string, service = getBrowserPublishService()) {
  return withDesktopAuth(request, () => Response.json(snapshotForProject(service.getSnapshot(), projectId)))
}

export async function handleBrowserPublishPost(
  request: Request,
  projectId: string,
  service: BrowserPublishServiceLike = getBrowserPublishService(),
) {
  return withDesktopAuth(request, async () => {
    const body = await readJsonObject(request)
    const artifactId = readString(body.artifactId)
    if (!artifactId || !isPublishPlatformId(body.platformId)) {
      return invalidRequest('invalid_browser_target', '请选择有效的发布包和平台。')
    }
    return Response.json(await service.open({ projectId, artifactId, platformId: body.platformId }))
  })
}

export async function handleBrowserPublishPatch(
  request: Request,
  projectId: string,
  service: BrowserPublishServiceLike = getBrowserPublishService(),
) {
  return withDesktopAuth(request, async () => {
    const current = service.getSnapshot()
    if (current.projectId && current.projectId !== projectId) {
      return invalidRequest('browser_session_mismatch', '当前浏览器正在处理另一个项目。', 409)
    }
    const body = await readJsonObject(request)
    if (body.action === 'refresh') return Response.json(await service.refresh())
    if (body.action === 'fill') {
      const artifactId = readString(body.artifactId)
      if (!artifactId || !isPublishPlatformId(body.platformId)) {
        return invalidRequest('invalid_browser_target', '请选择有效的发布包和平台。')
      }
      return Response.json(await service.fill({ projectId, artifactId, platformId: body.platformId }))
    }
    return invalidRequest('invalid_browser_action', '仅支持刷新登录状态或自动填写；最终发布必须由你手动确认。')
  })
}

export async function handleBrowserPublishDelete(
  request: Request,
  projectId: string,
  service: BrowserPublishServiceLike = getBrowserPublishService(),
) {
  return withDesktopAuth(request, async () => {
    const current = service.getSnapshot()
    if (current.projectId && current.projectId !== projectId) {
      return invalidRequest('browser_session_mismatch', '当前浏览器正在处理另一个项目。', 409)
    }
    return Response.json(await service.close())
  })
}

async function withDesktopAuth(request: Request, operation: () => Response | Promise<Response>) {
  try {
    authorizeDesktopCommand(request)
    return await operation()
  } catch (error) {
    const authResponse = desktopCommandAuthErrorResponse(error)
    if (authResponse) return authResponse
    if (error instanceof SyntaxError) return invalidRequest('invalid_json', '请求内容必须是有效 JSON。')
    return Response.json({
      status: 'failed', source: 'visible_browser', error: { code: 'browser_command_failed', message: error instanceof Error ? error.message : '浏览器命令失败。' },
    }, { status: 500 })
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new SyntaxError('content type')
  }
  const value = await request.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('body')
  return value as Record<string, unknown>
}

function snapshotForProject(snapshot: BrowserPublishSnapshot, projectId: string): BrowserPublishSnapshot {
  if (!snapshot.projectId || snapshot.projectId === projectId) return snapshot
  return { status: 'idle', source: 'visible_browser', updatedAt: new Date().toISOString() }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function invalidRequest(code: string, message: string, status = 400) {
  return Response.json({ status: 'invalid_request', source: 'visible_browser', error: { code, message } }, { status })
}
