import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { assertInsideRoot, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { readProjectStateFromWorkspaceRoot } from './project-state-service'

export interface ProjectImportIssue {
  projectId: string
  code: 'invalid_project' | 'unsafe_source' | 'copy_failed'
  message: string
}

export interface ProjectImportResult {
  status: 'ok' | 'partial'
  source: 'project_import'
  imported: string[]
  skipped: string[]
  issues: ProjectImportIssue[]
}

export class ProjectImportError extends Error {
  constructor(public readonly code: 'invalid_source_root' | 'source_root_not_found' | 'source_root_conflict', message: string) {
    super(message)
    this.name = 'ProjectImportError'
  }
}

export async function importLegacyProjects(sourceRootInput: string, options: { targetRoot?: string } = {}): Promise<ProjectImportResult> {
  const sourceRoot = path.resolve(sourceRootInput.trim())
  const targetRoot = path.resolve(options.targetRoot ?? getWorkspacesRoot())
  if (!sourceRootInput.trim() || !path.isAbsolute(sourceRootInput.trim())) {
    throw new ProjectImportError('invalid_source_root', '请选择旧项目的 workspaces 文件夹。')
  }
  if (pathsOverlap(sourceRoot, targetRoot)) {
    throw new ProjectImportError('source_root_conflict', '旧项目目录不能与当前项目目录重叠。')
  }
  const stat = await fs.lstat(sourceRoot).catch(() => undefined)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectImportError('source_root_not_found', '找不到所选旧项目文件夹。')
  }

  await fs.mkdir(targetRoot, { recursive: true })
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true })
  const imported: string[] = []
  const skipped: string[] = []
  const issues: ProjectImportIssue[] = []

  for (const entry of entries.filter((item) => item.isDirectory())) {
    let projectId = entry.name
    try {
      projectId = assertSafeSegment(entry.name, 'projectId')
      const sourceProjectRoot = assertInsideRoot(sourceRoot, path.join(/*turbopackIgnore: true*/ sourceRoot, projectId))
      const project = await readProjectStateFromWorkspaceRoot(sourceProjectRoot)
      if (project.projectId !== projectId) throw new Error('项目目录名与 projectId 不一致。')
      const targetProjectRoot = assertInsideRoot(targetRoot, path.join(/*turbopackIgnore: true*/ targetRoot, projectId))
      if (await exists(targetProjectRoot)) {
        skipped.push(projectId)
        continue
      }
      const stagingRoot = path.join(/*turbopackIgnore: true*/ path.dirname(targetRoot), 'import-staging')
      await fs.mkdir(stagingRoot, { recursive: true })
      const temporary = assertInsideRoot(stagingRoot, path.join(/*turbopackIgnore: true*/ stagingRoot, `${projectId}-${process.pid}-${Date.now()}`))
      try {
        await fs.mkdir(temporary, { recursive: false })
        await copyAllowedProjectContent(sourceProjectRoot, temporary)
        await readProjectStateFromWorkspaceRoot(temporary)
        await fs.rename(temporary, targetProjectRoot)
        imported.push(projectId)
      } catch (error) {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        issues.push({ projectId, code: 'copy_failed', message: safeImportMessage(error, '项目复制失败。') })
      }
    } catch (error) {
      issues.push({ projectId, code: 'invalid_project', message: safeImportMessage(error, '项目格式无效，已跳过。') })
    }
  }

  return {
    status: issues.length ? 'partial' : 'ok',
    source: 'project_import',
    imported,
    skipped,
    issues,
  }
}

async function copyAllowedProjectContent(sourceRoot: string, targetRoot: string) {
  await copySafeEntry(path.join(/*turbopackIgnore: true*/ sourceRoot, 'project.json'), path.join(/*turbopackIgnore: true*/ targetRoot, 'project.json'), sourceRoot)
  for (const directory of ['files', 'context', 'outputs', 'artifacts']) {
    const source = path.join(/*turbopackIgnore: true*/ sourceRoot, directory)
    if (await exists(source)) await copySafeEntry(source, path.join(/*turbopackIgnore: true*/ targetRoot, directory), sourceRoot)
  }
}

async function copySafeEntry(source: string, target: string, sourceRoot: string): Promise<void> {
  assertInsideRoot(sourceRoot, source)
  const stat = await fs.lstat(source)
  if (stat.isSymbolicLink()) throw new Error('项目包含符号链接，无法安全导入。')
  if (stat.isFile()) {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL)
    return
  }
  if (!stat.isDirectory()) throw new Error('项目包含不支持的文件类型。')
  await fs.mkdir(target, { recursive: false })
  for (const entry of await fs.readdir(source)) {
    await copySafeEntry(path.join(/*turbopackIgnore: true*/ source, entry), path.join(/*turbopackIgnore: true*/ target, entry), sourceRoot)
  }
}

function pathsOverlap(left: string, right: string) {
  const normalize = (value: string) => `${path.resolve(value).toLocaleLowerCase()}${path.sep}`
  const a = normalize(left)
  const b = normalize(right)
  return a.startsWith(b) || b.startsWith(a)
}

async function exists(target: string) {
  return fs.stat(target).then(() => true, () => false)
}

function safeImportMessage(error: unknown, fallback: string) {
  if (error instanceof Error && /project\.json|项目|符号链接/.test(error.message)) return error.message
  return fallback
}
