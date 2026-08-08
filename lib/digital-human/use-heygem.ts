'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RenderArtifact } from '@/lib/artifacts/render-artifact'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import {
  createHeyGemClient,
  createHeyGemTaskClient,
  statusFromHeyGemResult,
  type HeyGemClientResult,
  type HeyGemClientStatus,
  type HeyGemTaskClientResult,
} from './heygem-client'
import type { HeyGemGenerateInput } from './heygem-service'
import type { HeyGemTaskState } from './heygem-task'

const TERMINAL_RECOVERY_ERROR_CODES = new Set([
  'task_state_corrupt',
  'invalid_project_state',
  'workspace_guard',
])

export function useHeyGem(projectId: string, sessionId = 'avatar-session') {
  const [status, setStatus] = useState<HeyGemClientStatus>('recovering')
  const [lastResult, setLastResult] = useState<HeyGemClientResult | undefined>()
  const [task, setTask] = useState<HeyGemTaskState | undefined>()
  const [artifact, setArtifact] = useState<RenderArtifact | undefined>()
  const [project, setProject] = useState<ProjectStateDocument | undefined>()
  const [recoveryVersion, setRecoveryVersion] = useState(0)
  const client = useMemo(() => createHeyGemClient(), [])
  const taskClient = useMemo(() => createHeyGemTaskClient(), [])
  const identity = `${projectId}\u0000${sessionId}`
  const identityRef = useRef<string | undefined>(undefined)
  const epochRef = useRef(0)
  const recoveryControllerRef = useRef<AbortController | undefined>(undefined)
  const generationRef = useRef<{
    identity: string
    controller: AbortController
    promise: Promise<HeyGemClientResult>
  } | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const epoch = ++epochRef.current
    recoveryControllerRef.current?.abort()
    const controller = new AbortController()
    recoveryControllerRef.current = controller
    const identityChanged = identityRef.current !== identity
    identityRef.current = identity
    if (identityChanged && generationRef.current) {
      generationRef.current.controller.abort()
      generationRef.current = undefined
    }
    setStatus('recovering')
    setTask(undefined)
    setArtifact(undefined)
    setProject(undefined)
    if (identityChanged) setLastResult(undefined)

    function isCurrent() {
      return !disposed && !controller.signal.aborted && epochRef.current === epoch
    }

    function schedule(delayMs: number, retry: number) {
      if (!isCurrent()) return
      timer = setTimeout(() => void recover(retry), delayMs)
    }

    async function recover(retry = 0) {
      const result = await taskClient({ projectId, sessionId, signal: controller.signal }).catch((): HeyGemTaskClientResult => ({
        status: 'adapter_error',
        source: 'desktop_runtime',
        error: {
          code: 'unexpected_task_client_error',
          message: '数字人任务检查异常中断，稍后将自动重试。',
        },
      }))
      if (!isCurrent()) return
      if (result.status !== 'ok') {
        setLastResult(result)
        setTask(undefined)
        setArtifact(undefined)
        setProject(undefined)
        if (isTerminalRecoveryError(result)) {
          setStatus(result.status === 'invalid_request' ? 'invalid_request' : 'adapter_error')
          return
        }
        setStatus('recovering')
        schedule(recoveryBackoffMs(retry), retry + 1)
        return
      }
      setLastResult(undefined)
      setProject(result.project)
      if (!result.task) {
        setTask(undefined)
        setArtifact(undefined)
        setStatus('idle')
        return
      }
      if (result.task.projectId !== projectId || result.task.sessionId !== sessionId) {
        setTask(undefined)
        setArtifact(undefined)
        setLastResult({
          status: 'adapter_error',
          source: 'heygem_task',
          error: {
            code: 'task_identity_mismatch',
            message: '数字人任务不属于当前项目或会话，请重新检查。',
          },
        })
        setStatus('adapter_error')
        return
      }
      if (result.task.status === 'queued' || result.task.status === 'running') {
        setTask(result.task)
        setArtifact(undefined)
        setStatus('running')
        schedule(1500, 0)
        return
      }
      if (result.task.status === 'ready' && result.artifact?.status === 'ready'
        && result.artifact.artifactId === result.task.artifactId
        && isReadyProjectSelection(result, projectId, sessionId)) {
        setTask(result.task)
        setArtifact(result.artifact)
        setStatus('done')
        return
      }
      if (result.task.status === 'ready') {
        setTask(undefined)
        setArtifact(undefined)
        const artifactExists = result.artifact?.status === 'ready'
          && result.artifact.artifactId === result.task.artifactId
        setLastResult({
          status: 'adapter_error',
          source: 'heygem_task',
          error: {
            code: artifactExists ? 'render_project_state_mismatch' : 'render_artifact_missing',
            message: artifactExists
              ? '数字人成片与当前项目状态不一致，请重新生成。'
              : '数字人任务已完成，但成片尚未通过验证，请重新检查。',
          },
        })
        setStatus('adapter_error')
        return
      }
      setTask(result.task)
      setArtifact(undefined)
      setLastResult({
        status: 'adapter_error',
        source: 'heygem_task',
        error: result.task.error ?? {
          code: 'task_failed',
          message: '上次数字人生成任务失败，请重新生成。',
        },
      })
      setStatus('adapter_error')
    }

    void recover()
    return () => {
      disposed = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [identity, projectId, recoveryVersion, sessionId, taskClient])

  const generate = useCallback((input: {
    sessionId: string
    input: HeyGemGenerateInput
  }): Promise<HeyGemClientResult> => {
    const active = generationRef.current
    if (active?.identity === identity) return active.promise
    if (input.sessionId !== sessionId) {
      return Promise.resolve({
        status: 'invalid_request',
        source: 'heygem_client',
        error: {
          code: 'session_mismatch',
          message: '数字人生成会话已变化，请重新发起生成。',
        },
      })
    }
    if (active) active.controller.abort()
    recoveryControllerRef.current?.abort()
    const controller = new AbortController()
    const epoch = ++epochRef.current
    setTask(undefined)
    setArtifact(undefined)
    setProject(undefined)
    setLastResult(undefined)
    setStatus('running')

    const promise = Promise.resolve()
      .then(() => client({
        projectId,
        sessionId: input.sessionId,
        input: input.input,
        signal: controller.signal,
      }))
      .catch((): HeyGemClientResult => ({
        status: 'adapter_error',
        source: 'desktop_runtime',
        error: {
          code: 'unexpected_client_error',
          message: '数字人请求异常中断，正在检查任务是否已提交。',
        },
      }))
      .then((result) => {
        if (controller.signal.aborted || epochRef.current !== epoch || identityRef.current !== identity) {
          return result
        }
        setLastResult(result)
        if (result.status !== 'invalid_request') {
          setStatus('recovering')
          setRecoveryVersion((value) => value + 1)
        } else {
          setStatus(statusFromHeyGemResult(result))
        }
        return result
      })

    const operation = { identity, controller, promise }
    generationRef.current = operation
    promise.then(() => {
      if (generationRef.current === operation) generationRef.current = undefined
    })
    return promise
  }, [client, identity, projectId, sessionId])

  return {
    status,
    lastResult,
    task,
    artifact,
    project,
    generate,
  }
}

function isTerminalRecoveryError(result: Exclude<HeyGemTaskClientResult, { status: 'ok' }>) {
  if (result.status === 'invalid_request') return true
  return TERMINAL_RECOVERY_ERROR_CODES.has(result.error.code)
}

function recoveryBackoffMs(retry: number) {
  return Math.min(1000 * (2 ** retry), 8000)
}

function isReadyProjectSelection(
  result: Extract<HeyGemTaskClientResult, { status: 'ok' }>,
  projectId: string,
  sessionId: string,
) {
  const task = result.task
  const artifact = result.artifact
  const project = result.project
  const stage = project?.stages?.digitalHuman
  return Boolean(
    task
      && artifact
      && task.taskId
      && task.artifactId
      && task.projectId === projectId
      && task.sessionId === sessionId
      && artifact.projectId === projectId
      && artifact.sessionId === sessionId
      && artifact.source === 'heygem'
      && artifact.status === 'ready'
      && artifact.artifactId === task.artifactId
      && project.projectId === projectId
      && stage?.status === 'ready'
      && stage.source === 'heygem'
      && stage.artifactId === artifact.artifactId
      && stage.operation?.id === task.taskId
      && stage.operation.sessionId === sessionId,
  )
}
