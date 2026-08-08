import type { FeatureType } from '@/lib/features/feature-registry'

export interface ProjectWorkspace {
  workspaceId: string
  projectId: string
  featureType: FeatureType
  rootPath: string
  filesPath: string
  contextPath: string
  outputsPath: string
  artifactsPath: string
  sessionsRootPath: string
  featureSessionPath: string
  agentSessionsPath: string
}
