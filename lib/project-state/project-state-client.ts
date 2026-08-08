import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { ScriptDraft } from '@/lib/workspace'
import type { ProjectStateListResult, ProjectStateMutation, ProjectStateResult } from './project-state-types'

export function projectStateEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/state')
}

export function createProjectStateClient(fetcher: typeof fetch = fetch) {
  const fallback = (error: { code: string; message: string }): ProjectStateResult => ({ status: 'project_state_error', source: 'project_state', error })
  return {
    list: () => requestJson<ProjectStateListResult | ProjectStateResult>('/api/projects', { fetcher, fallback }),
    create: (input: { projectId?: string; script: ScriptDraft }) => requestJson<ProjectStateResult>('/api/projects', {
      fetcher,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
      fallback,
    }),
    get: (projectId: string) => requestJson<ProjectStateResult>(projectStateEndpoint(projectId), { fetcher, fallback }),
    mutate: (projectId: string, mutation: ProjectStateMutation) => requestJson<ProjectStateResult>(projectStateEndpoint(projectId), {
      fetcher,
      init: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mutation) },
      fallback,
    }),
    importLegacy: (sourceRoot: string) => requestJson<{
      status: 'ok' | 'partial' | 'invalid_request' | 'project_import_error'
      source: 'project_import'
      imported?: string[]
      skipped?: string[]
      issues?: Array<{ projectId: string; code: string; message: string }>
      error?: { code: string; message: string }
    }>('/api/projects/import', {
      fetcher,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceRoot }) },
      fallback: (error) => ({ status: 'project_import_error', source: 'project_import', error }),
    }),
  }
}
