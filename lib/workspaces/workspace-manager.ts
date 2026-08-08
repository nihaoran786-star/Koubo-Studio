import fs from 'node:fs/promises'
import path from 'node:path'
import type { FeatureType } from '@/lib/features/feature-registry'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { getRuntimeDataRoot } from '@/lib/runtime-data/runtime-data-root'

const WORKSPACES_ROOT = process.env.KOUBO_WORKSPACES_ROOT?.trim() ||
  path.join(/*turbopackIgnore: true*/ getRuntimeDataRoot(), 'workspaces')

export async function ensureProjectWorkspace(
  projectId: string,
  featureType: FeatureType,
): Promise<ProjectWorkspace> {
  const safeProjectId = assertSafeSegment(projectId, 'projectId')
  const safeFeatureType = assertSafeSegment(featureType, 'featureType') as FeatureType

  const rootPath = assertInsideRoot(WORKSPACES_ROOT, path.join(/*turbopackIgnore: true*/ WORKSPACES_ROOT, safeProjectId))
  const filesPath = assertInsideRoot(rootPath, path.join(/*turbopackIgnore: true*/ rootPath, 'files'))
  const contextPath = assertInsideRoot(rootPath, path.join(/*turbopackIgnore: true*/ rootPath, 'context'))
  const outputsPath = assertInsideRoot(rootPath, path.join(/*turbopackIgnore: true*/ rootPath, 'outputs'))
  const artifactsPath = assertInsideRoot(rootPath, path.join(/*turbopackIgnore: true*/ rootPath, 'artifacts'))
  const sessionsRootPath = assertInsideRoot(rootPath, path.join(/*turbopackIgnore: true*/ rootPath, 'sessions'))
  const featureSessionPath = assertInsideRoot(
    sessionsRootPath,
    path.join(/*turbopackIgnore: true*/ sessionsRootPath, safeFeatureType),
  )
  const agentSessionsPath = assertInsideRoot(
    sessionsRootPath,
    path.join(/*turbopackIgnore: true*/ sessionsRootPath, 'agents'),
  )

  await Promise.all([
    fs.mkdir(filesPath, { recursive: true }),
    fs.mkdir(contextPath, { recursive: true }),
    fs.mkdir(outputsPath, { recursive: true }),
    fs.mkdir(artifactsPath, { recursive: true }),
    fs.mkdir(featureSessionPath, { recursive: true }),
    fs.mkdir(agentSessionsPath, { recursive: true }),
  ])

  return {
    workspaceId: safeProjectId,
    projectId: safeProjectId,
    featureType: safeFeatureType,
    rootPath,
    filesPath,
    contextPath,
    outputsPath,
    artifactsPath,
    sessionsRootPath,
    featureSessionPath,
    agentSessionsPath,
  }
}

export function getWorkspacesRoot() {
  return WORKSPACES_ROOT
}
