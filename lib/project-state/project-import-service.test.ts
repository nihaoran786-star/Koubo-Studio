import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importLegacyProjects, ProjectImportError } from './project-import-service'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe('importLegacyProjects', () => {
  it('copies valid projects, skips existing projects, isolates damage, and never copies sessions', async () => {
    const root = await makeRoot()
    const source = path.join(root, 'old-workspaces')
    const target = path.join(root, 'app-data', 'workspaces')
    await writeProject(source, 'good-project')
    await fs.mkdir(path.join(source, 'broken-project'), { recursive: true })
    await fs.writeFile(path.join(source, 'broken-project', 'project.json'), '{broken', 'utf8')
    await writeProject(source, 'already-there')
    await writeProject(target, 'already-there')

    const before = await fs.readFile(path.join(source, 'good-project', 'project.json'), 'utf8')
    const result = await importLegacyProjects(source, { targetRoot: target })

    expect(result).toMatchObject({ status: 'partial', imported: ['good-project'], skipped: ['already-there'] })
    expect(result.issues).toEqual([expect.objectContaining({ projectId: 'broken-project', code: 'invalid_project' })])
    await expect(fs.readFile(path.join(target, 'good-project', 'files', 'clip.txt'), 'utf8')).resolves.toBe('media')
    await expect(fs.stat(path.join(target, 'good-project', 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(source, 'good-project', 'project.json'), 'utf8')).resolves.toBe(before)
  })

  it('rejects relative and overlapping roots', async () => {
    const root = await makeRoot()
    await expect(importLegacyProjects('relative/path', { targetRoot: path.join(root, 'target') })).rejects.toBeInstanceOf(ProjectImportError)
    await expect(importLegacyProjects(root, { targetRoot: path.join(root, 'workspaces') })).rejects.toMatchObject({ code: 'source_root_conflict' })
  })
})

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-import-test-'))
  roots.push(root)
  return root
}

async function writeProject(workspacesRoot: string, projectId: string) {
  const root = path.join(workspacesRoot, projectId)
  await fs.mkdir(path.join(root, 'files'), { recursive: true })
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(root, 'files', 'clip.txt'), 'media', 'utf8')
  await fs.writeFile(path.join(root, 'sessions', 'private.txt'), 'do not import', 'utf8')
  await fs.writeFile(path.join(root, 'project.json'), JSON.stringify({
    version: 1,
    revision: 1,
    projectId,
    title: '测试项目',
    status: 'draft',
    currentStep: 'idea',
    furthestStep: 'idea',
    stages: Object.fromEntries(['script', 'voice', 'digitalHuman', 'edit', 'publish'].map((id) => [id, { status: id === 'script' ? 'needs_input' : 'idle', updatedAt: '2026-01-01T00:00:00.000Z' }])),
    script: { approvalStatus: 'draft', topic: '', platforms: ['抖音'], duration: '30 秒', tone: '自然', chatStage: 'brief', messages: [], title: '', hook: '', body: '', caption: '', tags: [], generated: false, updatedAt: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }), 'utf8')
}
