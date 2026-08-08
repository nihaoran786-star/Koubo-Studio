import { rejectUntrustedApiWrite } from '@/lib/api/api-cors'
import { importLegacyProjects, ProjectImportError } from '@/lib/project-state/project-import-service'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const rejected = rejectUntrustedApiWrite(request)
  if (rejected) return rejected
  try {
    const body = await request.json() as { sourceRoot?: unknown }
    if (typeof body.sourceRoot !== 'string') {
      return Response.json({ status: 'invalid_request', source: 'project_import', error: { code: 'invalid_source_root', message: '请选择旧项目文件夹。' } }, { status: 400 })
    }
    return Response.json(await importLegacyProjects(body.sourceRoot))
  } catch (error) {
    if (error instanceof ProjectImportError) {
      return Response.json({ status: 'invalid_request', source: 'project_import', error: { code: error.code, message: error.message } }, { status: 400 })
    }
    return Response.json({ status: 'project_import_error', source: 'project_import', error: { code: 'project_import_failed', message: '旧项目导入失败，请检查目录权限。' } }, { status: 500 })
  }
}
