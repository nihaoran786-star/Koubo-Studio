import type { ChamberId } from '@/lib/chambers'
import type { ProjectStatus } from '@/lib/projects'
import type { ScriptDraft } from '@/lib/workspace'

export type CreationStageStatus = 'idle' | 'needs_input' | 'queued' | 'running' | 'ready' | 'failed'
export type CreationStageId = 'script' | 'voice' | 'digitalHuman' | 'edit' | 'publish'
export type OperableCreationStageId = Exclude<CreationStageId, 'script'>
export type CreationStageSource = 'indextts2' | 'heygem' | 'local_ffmpeg' | 'openchatcut' | 'local_publish_package'

export interface CreationStageOperation {
  id: string
  sessionId: string
  upstreamArtifactId: string
  startedAt: string
}

export interface CreationStageState {
  status: CreationStageStatus
  artifactId?: string
  source?: CreationStageSource
  operation?: CreationStageOperation
  error?: { code: string; message: string }
  updatedAt: string
}

export interface ProjectStateDocument {
  version: 1
  revision: number
  projectId: string
  title: string
  status: ProjectStatus
  currentStep: ChamberId
  furthestStep: ChamberId
  stages: Record<CreationStageId, CreationStageState>
  script: ScriptDraft
  createdAt: string
  updatedAt: string
}

export type ProjectStateCommand =
  | { operation: 'update_script'; script: ScriptDraft }
  | { operation: 'set_current_step'; step: ChamberId }
  | { operation: 'select_artifact'; stage: Exclude<CreationStageId, 'script'>; artifactId: string }

export type ProjectStateMutation = ProjectStateCommand & { expectedRevision?: number }

export interface BeginProjectStageOperationInput {
  projectId: string
  stage: OperableCreationStageId
  operationId: string
  sessionId: string
  source: CreationStageSource
  expectedUpstreamArtifactId: string
  now?: string
}

export interface ProjectStageOperationTransitionInput {
  projectId: string
  stage: OperableCreationStageId
  operationId: string
  now?: string
}

export interface CompleteProjectStageOperationInput extends ProjectStageOperationTransitionInput {
  artifactId: string
}

export interface FailProjectStageOperationInput extends ProjectStageOperationTransitionInput {
  error: { code: string; message: string }
}

export type ProjectStageTaskObservation =
  | {
      status: 'ready'
      operationId: string
      sessionId: string
      source: CreationStageSource
      artifactId: string
    }
  | {
      status: 'failed'
      operationId: string
      sessionId: string
      source: CreationStageSource
      error: { code: string; message: string }
    }
  | {
      status: 'missing'
      sessionId: string
      source: CreationStageSource
    }

export interface ReconcileProjectStageOperationInput {
  projectId: string
  stage: OperableCreationStageId
  task: ProjectStageTaskObservation
  now?: string
  missingTaskRecoveryWindowMs?: number
}

export interface ProjectStateListIssue {
  projectId: string
  code: string
  message: string
}

export type ProjectStateListResult =
  | { status: 'ok'; source: 'project_state'; projects: ProjectStateDocument[]; issues: [] }
  | { status: 'degraded'; source: 'project_state'; projects: ProjectStateDocument[]; issues: ProjectStateListIssue[] }

export type ProjectStateResult =
  | { status: 'ok'; source: 'project_state'; project: ProjectStateDocument }
  | { status: 'invalid_request' | 'not_found' | 'project_state_error'; source: 'project_state'; error: { code: string; message: string } }
