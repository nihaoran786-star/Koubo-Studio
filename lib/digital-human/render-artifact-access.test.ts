import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { saveRenderArtifact } from '@/lib/artifacts/render-artifact'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { getCurrentRenderArtifactAccess } from './render-artifact-access'

const projectId = 'render-access-project'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('getCurrentRenderArtifactAccess', () => {
  it('authorises only the current ready artifact with complete project lineage', async () => {
    const fixture = await createFixture()

    await expect(getCurrentRenderArtifactAccess({ projectId, artifactId: fixture.artifactId }))
      .resolves.toMatchObject({
        artifact: { artifactId: fixture.artifactId },
        renderRootPath: path.dirname(fixture.outputPath),
      })
  })

  it.each([
    ['stage artifact', (project: ProjectStateDocument) => { project.stages.digitalHuman.artifactId = 'render-new' }],
    ['operation', (project: ProjectStateDocument) => { project.stages.digitalHuman.operation!.id = 'render-new' }],
    ['session', (project: ProjectStateDocument) => { project.stages.digitalHuman.operation!.sessionId = 'other-session' }],
    ['voice lineage', (project: ProjectStateDocument) => { project.stages.voice.artifactId = 'audio-new' }],
    ['script lineage', (project: ProjectStateDocument) => { project.stages.script.artifactId = 'script-new' }],
  ])('rejects an artifact after the current %s changes', async (_label, mutate) => {
    const fixture = await createFixture()
    mutate(fixture.project)
    fixture.project.revision += 1
    await fs.writeFile(fixture.projectPath, JSON.stringify(fixture.project), 'utf8')

    await expect(getCurrentRenderArtifactAccess({ projectId, artifactId: fixture.artifactId }))
      .rejects.toMatchObject({ code: 'artifact_not_current' })
  })

  it('does not reveal whether a non-current artifact record exists', async () => {
    await createFixture()

    await expect(getCurrentRenderArtifactAccess({ projectId, artifactId: 'render-missing' }))
      .rejects.toMatchObject({ code: 'artifact_not_current' })
  })
})

async function createFixture() {
  const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
  const artifactId = 'render-current'
  const outputPath = resolveArtifactPath(workspace, 'render', `${artifactId}.mp4`)
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, 'video')
  await saveRenderArtifact({
    workspace,
    artifactId,
    sessionId: 'avatar-session',
    status: 'ready',
    source: 'heygem',
    scriptArtifactId: 'script-current',
    audioArtifactId: 'audio-current',
    outputPath,
    durationSeconds: 1,
    avatar: { source: 'library', id: 'avatar-current', name: '当前形象' },
    mode: 'standard',
    now: '2026-07-17T00:00:00.000Z',
  })
  const project = currentProject(artifactId)
  const projectPath = path.join(workspace.rootPath, 'project.json')
  await fs.writeFile(projectPath, JSON.stringify(project), 'utf8')
  return { artifactId, outputPath, project, projectPath }
}

function currentProject(artifactId: string): ProjectStateDocument {
  const now = '2026-07-17T00:00:00.000Z'
  return {
    version: 1,
    revision: 1,
    projectId,
    title: '测试项目',
    status: 'editing',
    currentStep: 'avatar',
    furthestStep: 'avatar',
    stages: {
      script: { status: 'ready', artifactId: 'script-current', updatedAt: now },
      voice: { status: 'ready', artifactId: 'audio-current', source: 'indextts2', updatedAt: now },
      digitalHuman: {
        status: 'ready',
        artifactId,
        source: 'heygem',
        operation: {
          id: artifactId,
          sessionId: 'avatar-session',
          upstreamArtifactId: 'audio-current',
          startedAt: now,
        },
        updatedAt: now,
      },
      edit: { status: 'needs_input', updatedAt: now },
      publish: { status: 'idle', updatedAt: now },
    },
    script: {} as ProjectStateDocument['script'],
    createdAt: now,
    updatedAt: now,
  }
}
