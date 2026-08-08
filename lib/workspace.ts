'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChamberId } from './chambers'
import type { Project, ProjectStatus } from './projects'
import { createProjectStateClient } from './project-state/project-state-client'
import type { CreationStageId, ProjectStateCommand, ProjectStateDocument, ProjectStateMutation } from './project-state/project-state-types'

const LEGACY_STORAGE_KEY = 'koubo-agent.workspace.v1'
const MIGRATION_KEY = 'koubo-agent.project-state-migrated.v1'

export interface ScriptDraft {
  artifactId?: string
  approvalStatus: 'draft' | 'approved'
  topic: string
  platforms: string[]
  duration: string
  tone: string
  chatStage: 'brief' | 'chatting' | 'generated'
  messages: { id: string; role: 'ai' | 'user'; text: string }[]
  title: string
  hook: string
  body: string
  caption: string
  tags: string[]
  generated: boolean
  updatedAt: string
}

export interface WorkspaceProject extends Project {
  createdAt: string
  revision: number
  furthestStep: number
  script: ScriptDraft
  selectedAudioArtifactId?: string
  selectedRenderArtifactId?: string
  selectedPostProductionArtifactId?: string
  selectedPublishPackageArtifactId?: string
}

interface LegacyWorkspaceProject extends WorkspaceProject {}

export function emptyScript(): ScriptDraft {
  const now = new Date().toISOString()
  return {
    approvalStatus: 'draft', topic: '', platforms: ['抖音', '小红书'], duration: '30 秒', tone: '专业教程',
    chatStage: 'brief', messages: [], title: '', hook: '', body: '', caption: '', tags: [], generated: false, updatedAt: now,
  }
}

export function useWorkspace() {
  const client = useMemo(() => createProjectStateClient(), [])
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'degraded' | 'error'>('loading')
  const [documents, setDocuments] = useState<ProjectStateDocument[]>([])
  const [error, setError] = useState<{ code: string; message: string }>()
  const mounted = useRef(false)
  const revisions = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<void>>())
  const scriptTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const loadProjects = useCallback(async () => {
      const result = await client.list()
      if (!mounted.current) return
      if ((result.status !== 'ok' && result.status !== 'degraded') || !('projects' in result)) {
        setError('error' in result ? result.error : { code: 'invalid_project_list', message: '项目列表响应格式无效。' })
        setStatus('error')
        setReady(true)
        return
      }
      let projects = result.projects
      const legacy = readLegacyProjects()
      if (legacy.length && window.localStorage.getItem(MIGRATION_KEY) !== 'done') {
        const migrated = await migrateLegacyProjects(client, projects, legacy)
        if (migrated.ok) {
          projects = migrated.projects
          window.localStorage.setItem(MIGRATION_KEY, 'done')
          window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      }
      if (!mounted.current) return
      revisions.current = new Map(projects.map((project) => [project.projectId, project.revision]))
      setDocuments(projects)
      if (result.status === 'degraded') {
        setError(result.issues[0] ?? { code: 'project_list_degraded', message: '部分项目暂时无法读取。' })
        setStatus('degraded')
      } else {
        setError(undefined)
        setStatus('ready')
      }
      setReady(true)
  }, [client])

  useEffect(() => {
    mounted.current = true
    void loadProjects()
    return () => {
      mounted.current = false
      for (const timer of scriptTimers.current.values()) clearTimeout(timer)
    }
  }, [loadProjects])

  const projects = useMemo(() => documents.map(toWorkspaceProject), [documents])

  async function createProject() {
    const result = await client.create({ script: emptyScript() })
    if (result.status !== 'ok') {
      setError(result.error)
      throw new Error(result.error.message)
    }
    revisions.current.set(result.project.projectId, result.project.revision)
    setDocuments((current) => [result.project, ...current.filter((item) => item.projectId !== result.project.projectId)])
    return result.project.projectId
  }

  function updateProjectStep(projectId: string, step: ChamberId, _index: number) {
    setDocuments((current) => current.map((project) => project.projectId === projectId ? optimisticStep(project, step) : project))
    enqueue(projectId, { operation: 'set_current_step', step })
  }

  function updateScript(projectId: string, script: ScriptDraft) {
    setDocuments((current) => current.map((project) => project.projectId === projectId ? optimisticScript(project, script) : project))
    const existing = scriptTimers.current.get(projectId)
    if (existing) clearTimeout(existing)
    scriptTimers.current.set(projectId, setTimeout(() => {
      scriptTimers.current.delete(projectId)
      enqueue(projectId, { operation: 'update_script', script })
    }, 350))
  }

  function updateSelectedAudioArtifact(projectId: string, artifactId: string) { selectArtifact(projectId, 'voice', artifactId) }
  function updateSelectedRenderArtifact(projectId: string, artifactId: string) { selectArtifact(projectId, 'digitalHuman', artifactId) }
  function updateSelectedPostProductionArtifact(projectId: string, artifactId: string) { selectArtifact(projectId, 'edit', artifactId) }
  function updateSelectedPublishPackageArtifact(projectId: string, artifactId: string) { selectArtifact(projectId, 'publish', artifactId) }

  function selectArtifact(projectId: string, stage: Exclude<CreationStageId, 'script'>, artifactId: string) {
    enqueue(projectId, { operation: 'select_artifact', stage, artifactId })
  }

  function enqueue(projectId: string, command: ProjectStateCommand) {
    const previous = queues.current.get(projectId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const mutation: ProjectStateMutation = { ...command, expectedRevision: revisions.current.get(projectId) } as ProjectStateMutation
      let result = await client.mutate(projectId, mutation)
      if (result.status !== 'ok' && result.error.code === 'revision_conflict') {
        const refreshed = await client.get(projectId)
        if (refreshed.status === 'ok') {
          revisions.current.set(projectId, refreshed.project.revision)
          result = await client.mutate(projectId, { ...command, expectedRevision: refreshed.project.revision } as ProjectStateMutation)
        }
      }
      if (result.status === 'ok') {
        revisions.current.set(projectId, result.project.revision)
        setDocuments((current) => current.map((project) => project.projectId === projectId ? result.project : project))
        return
      }
      setError(result.error)
      const refreshed = await client.get(projectId)
      if (refreshed.status === 'ok') {
        revisions.current.set(projectId, refreshed.project.revision)
        setDocuments((current) => current.map((project) => project.projectId === projectId ? refreshed.project : project))
      }
    }).finally(() => {
      if (queues.current.get(projectId) === next) queues.current.delete(projectId)
    })
    queues.current.set(projectId, next)
  }

  return {
    ready,
    status,
    error,
    projects,
    retry: loadProjects,
    createProject,
    updateProjectStep,
    updateScript,
    updateSelectedAudioArtifact,
    updateSelectedRenderArtifact,
    updateSelectedPostProductionArtifact,
    updateSelectedPublishPackageArtifact,
  }
}

function optimisticStep(project: ProjectStateDocument, step: ChamberId): ProjectStateDocument {
  const order: ChamberId[] = ['idea', 'voice', 'avatar', 'render', 'publish']
  return {
    ...project,
    currentStep: step,
    furthestStep: order.indexOf(step) > order.indexOf(project.furthestStep) ? step : project.furthestStep,
  }
}

function optimisticScript(project: ProjectStateDocument, script: ScriptDraft): ProjectStateDocument {
  return { ...project, title: script.title.trim() || script.topic.trim() || '未命名口播作品', script: { ...script, updatedAt: new Date().toISOString() } }
}

function toWorkspaceProject(project: ProjectStateDocument): WorkspaceProject {
  const stepOrder: ChamberId[] = ['idea', 'voice', 'avatar', 'render', 'publish']
  const duration = project.script.duration === '60 秒' ? '01:00' : project.script.duration === '45 秒' ? '00:45' : '00:30'
  const postArtifactId = project.stages.edit.status === 'ready' ? project.stages.edit.artifactId : undefined
  const renderArtifactId = project.stages.digitalHuman.status === 'ready' ? project.stages.digitalHuman.artifactId : undefined
  const cover = postArtifactId
    ? `/api/projects/${encodeURIComponent(project.projectId)}/post-production-artifacts/${encodeURIComponent(postArtifactId)}/file`
    : renderArtifactId
      ? `/api/projects/${encodeURIComponent(project.projectId)}/render-artifacts/${encodeURIComponent(renderArtifactId)}/file`
      : ''
  return {
    id: project.projectId,
    title: project.title,
    cover,
    coverMediaType: cover ? 'video' : undefined,
    status: project.status,
    duration,
    updatedAt: formatRelativeTime(project.updatedAt),
    platforms: project.script.platforms,
    step: stepOrder.indexOf(project.currentStep) + 1,
    furthestStep: stepOrder.indexOf(project.furthestStep) + 1,
    revision: project.revision,
    createdAt: project.createdAt,
    script: project.script,
    selectedAudioArtifactId: project.stages.voice.artifactId,
    selectedRenderArtifactId: renderArtifactId,
    selectedPostProductionArtifactId: postArtifactId,
    selectedPublishPackageArtifactId: project.stages.publish.artifactId,
  }
}

async function migrateLegacyProjects(
  client: ReturnType<typeof createProjectStateClient>,
  serverProjects: ProjectStateDocument[],
  legacyProjects: LegacyWorkspaceProject[],
) {
  const projects = [...serverProjects]
  const existing = new Set(projects.map((project) => project.projectId))
  for (const legacy of legacyProjects) {
    if (existing.has(legacy.id)) continue
    const created = await client.create({ projectId: legacy.id, script: legacy.script })
    if (created.status !== 'ok') return { ok: false as const, projects: serverProjects }
    let project = created.project
    for (const [stage, artifactId] of [
      ['voice', legacy.selectedAudioArtifactId],
      ['digitalHuman', legacy.selectedRenderArtifactId],
      ['edit', legacy.selectedPostProductionArtifactId],
    ] as const) {
      if (!artifactId) continue
      const selected = await client.mutate(project.projectId, { operation: 'select_artifact', stage, artifactId, expectedRevision: project.revision })
      if (selected.status === 'ok') project = selected.project
      else if (selected.status === 'project_state_error') return { ok: false as const, projects: serverProjects }
    }
    const stepOrder: ChamberId[] = ['idea', 'voice', 'avatar', 'render', 'publish']
    const step = stepOrder[Math.max(0, Math.min((legacy.step ?? 1) - 1, stepOrder.length - 1))]
    const navigated = await client.mutate(project.projectId, { operation: 'set_current_step', step, expectedRevision: project.revision })
    if (navigated.status === 'ok') project = navigated.project
    projects.push(project)
    existing.add(project.projectId)
  }
  return { ok: true as const, projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
}

function readLegacyProjects(): LegacyWorkspaceProject[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { projects?: LegacyWorkspaceProject[] }
    return Array.isArray(parsed.projects) ? parsed.projects.filter((project) => project && typeof project.id === 'string' && project.script) : []
  } catch { return [] }
}

function formatRelativeTime(iso: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export type { ProjectStatus }
