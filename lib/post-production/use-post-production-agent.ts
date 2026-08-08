'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import {
  createPostProductionAgentClient,
  createPostProductionTaskClient,
  statusFromPostProductionAgentResult,
  type PostProductionAgentClientResult,
  type PostProductionAgentClientStatus,
  type PostProductionTaskClientResult,
} from './post-production-agent-client'
import type { PostProductionAgentInput } from './post-production-agent-service'
import type { PostProductionTaskState } from './post-production-task'

const TERMINAL_ERRORS = new Set(['task_state_corrupt', 'invalid_project_state', 'workspace_guard'])

export function usePostProductionAgent(projectId: string, sessionId = 'post-session') {
  const [status, setStatus] = useState<PostProductionAgentClientStatus>('recovering')
  const [lastResult, setLastResult] = useState<PostProductionAgentClientResult | PostProductionTaskClientResult>()
  const [task, setTask] = useState<PostProductionTaskState>()
  const [artifact, setArtifact] = useState<PostProductionArtifact>()
  const [project, setProject] = useState<ProjectStateDocument>()
  const [recoveryVersion, setRecoveryVersion] = useState(0)
  const client = useMemo(() => createPostProductionAgentClient(), [])
  const taskClient = useMemo(() => createPostProductionTaskClient(), [])
  const identity = `${projectId}\u0000${sessionId}`
  const epoch = useRef(0)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const activeRun = useRef<{ identity: string; promise: Promise<PostProductionAgentClientResult>; controller: AbortController } | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const currentEpoch = ++epoch.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setStatus('recovering'); setTask(undefined); setArtifact(undefined); setProject(undefined)
    const current = () => !disposed && !controller.signal.aborted && epoch.current === currentEpoch
    const schedule = (delay: number, retry: number) => { if (current()) timer = setTimeout(() => void recover(retry), delay) }
    async function recover(retry = 0) {
      const result = await taskClient({ projectId, sessionId, signal: controller.signal }).catch((): PostProductionTaskClientResult => ({
        status: 'skill_error', source: 'desktop_runtime', error: { code: 'unexpected_task_client_error', message: '剪辑任务检查中断，稍后自动重试。' },
      }))
      if (!current()) return
      if (result.status !== 'ok') {
        setLastResult(result); setTask(undefined); setArtifact(undefined); setProject(undefined)
        if (result.status === 'invalid_request' || TERMINAL_ERRORS.has(result.error.code)) setStatus(result.status)
        else { setStatus('recovering'); schedule(Math.min(1000 * 2 ** retry, 8000), retry + 1) }
        return
      }
      setLastResult(undefined); setProject(result.project)
      if (!result.task) { setTask(undefined); setArtifact(undefined); setStatus('idle'); return }
      if (result.task.projectId !== projectId || result.task.sessionId !== sessionId) {
        setStatus('skill_error'); setTask(undefined); setArtifact(undefined); return
      }
      if (result.task.status === 'queued' || result.task.status === 'running') {
        setTask(result.task); setArtifact(undefined); setStatus('running'); schedule(1500, 0); return
      }
      if (result.task.status === 'ready' && result.artifact?.status === 'ready' && result.project.stages.edit.artifactId === result.artifact.artifactId) {
        setTask(result.task); setArtifact(result.artifact); setStatus('done'); return
      }
      setTask(result.task); setArtifact(undefined); setStatus('skill_error')
      setLastResult({ status: 'skill_error', source: 'post_production_task', error: result.task.error ?? { code: 'edit_artifact_invalid', message: '成片未通过恢复验证，请重新导出。' } })
    }
    void recover()
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer) }
  }, [identity, projectId, recoveryVersion, sessionId, taskClient])

  const run = useCallback((input: { sessionId: string; input: PostProductionAgentInput }) => {
    if (input.sessionId !== sessionId) return Promise.resolve({ status: 'invalid_request', source: 'post_production_client', error: { code: 'session_mismatch', message: '剪辑会话已变化，请重试。' } } as PostProductionAgentClientResult)
    if (activeRun.current?.identity === identity) return activeRun.current.promise
    activeRun.current?.controller.abort(); controllerRef.current?.abort()
    const controller = new AbortController(); const currentEpoch = ++epoch.current
    setStatus('running'); setArtifact(undefined); setLastResult(undefined)
    const promise = client({ projectId, sessionId, input: input.input, signal: controller.signal })
      .catch((): PostProductionAgentClientResult => ({ status: 'skill_error', source: 'desktop_runtime', error: { code: 'unexpected_client_error', message: '剪辑请求中断，正在恢复任务。' } }))
      .then((result) => {
        if (!controller.signal.aborted && epoch.current === currentEpoch) {
          setLastResult(result)
          if (result.status === 'invalid_request') setStatus(statusFromPostProductionAgentResult(result))
          else { setStatus('recovering'); setRecoveryVersion((value) => value + 1) }
        }
        return result
      })
    const operation = { identity, promise, controller }; activeRun.current = operation
    promise.finally(() => { if (activeRun.current === operation) activeRun.current = undefined })
    return promise
  }, [client, identity, projectId, sessionId])

  return { status, lastResult, task, artifact, project, run }
}
