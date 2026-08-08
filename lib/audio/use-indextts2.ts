'use client'

import { useEffect, useRef, useState } from 'react'
import {
  createIndexTTS2Client,
  createIndexTTS2TaskClient,
  statusFromIndexTTS2Result,
  type IndexTTS2ClientResult,
  type IndexTTS2ClientStatus,
} from './indextts2-client'
import type { IndexTTS2TaskState } from './indextts2-task'
import type { VoiceGenerationParameters } from './voice-generation'

export function useIndexTTS2(projectId: string, sessionId = 'voice-session') {
  const [status, setStatus] = useState<IndexTTS2ClientStatus>('idle')
  const [lastResult, setLastResult] = useState<IndexTTS2ClientResult | undefined>()
  const [task, setTask] = useState<IndexTTS2TaskState | undefined>()
  const generatingRef = useRef(false)
  const client = createIndexTTS2Client()

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const taskClient = createIndexTTS2TaskClient()

    async function recover() {
      const result = await taskClient({ projectId, sessionId })
      if (disposed || generatingRef.current) return
      if (result.status !== 'ok') {
        setLastResult(result)
        setStatus('adapter_error')
        return
      }
      setTask(result.task)
      if (!result.task) {
        setStatus('idle')
        return
      }
      if (result.task.status === 'queued' || result.task.status === 'running') {
        setStatus('running')
        timer = setTimeout(() => void recover(), 1500)
        return
      }
      if (result.task.status === 'ready' && result.artifact) {
        setLastResult({
          status: 'ok',
          source: 'indextts2_service',
          artifact: result.artifact,
        })
        setStatus('done')
        return
      }
      const error = result.task.error ?? {
        code: result.task.status === 'ready' ? 'task_artifact_missing' : 'task_failed',
        message: result.task.status === 'ready'
          ? '声音任务已完成，但音频产物无法恢复，请重新生成。'
          : '上次声音生成任务失败，请重新生成。',
      }
      setLastResult({
        status: 'adapter_error',
        source: 'indextts2_task',
        error,
      })
      setStatus('adapter_error')
    }

    void recover()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [projectId, sessionId])

  async function generate(input: {
    sessionId: string
    parameters: VoiceGenerationParameters
  }) {
    generatingRef.current = true
    setStatus('running')
    const result = await client({
      projectId,
      sessionId: input.sessionId,
      parameters: input.parameters,
    })
    generatingRef.current = false
    setLastResult(result)
    setStatus(statusFromIndexTTS2Result(result))
    if (result.status === 'ok') {
      setTask({
        taskId: result.artifact.artifactId,
        projectId,
        sessionId: input.sessionId,
        status: 'ready',
        artifactId: result.artifact.artifactId,
        createdAt: result.artifact.createdAt,
        updatedAt: result.artifact.updatedAt,
      })
    }
    return result
  }

  return {
    status,
    lastResult,
    task,
    generate,
  }
}
