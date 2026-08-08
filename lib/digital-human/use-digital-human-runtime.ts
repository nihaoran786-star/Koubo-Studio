'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createManagedRuntimeClient } from '@/lib/managed-runtime/managed-runtime-client'
import { createManagedRuntimeImportClient } from '@/lib/managed-runtime/managed-runtime-import-client'
import { createRuntimeReadinessClient } from '@/lib/runtime-readiness/runtime-readiness-client'

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_MAX_POLL_ATTEMPTS = 30

type GateStatus = 'checking' | 'ready' | 'startable' | 'preparing' | 'blocked'

export interface DigitalHumanRuntimeGateResult {
  ready: boolean
  message?: string
  action?: 'open_settings'
}

interface DigitalHumanRuntimeGateState {
  status: GateStatus
  canGenerate: boolean
  preparing: boolean
  message?: string
  action?: 'open_settings'
}

interface RuntimeSnapshot {
  ready: boolean
  startable: boolean
  shouldStart: boolean
  message?: string
  action?: 'open_settings'
}

export function useDigitalHumanRuntime({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
}: {
  pollIntervalMs?: number
  maxPollAttempts?: number
} = {}) {
  const readinessClient = useMemo(() => createRuntimeReadinessClient(), [])
  const managedClient = useMemo(() => createManagedRuntimeClient(), [])
  const lifecycleClient = useMemo(() => createManagedRuntimeImportClient(), [])
  const mountedRef = useRef(false)
  const epochRef = useRef(0)
  const ensureRef = useRef<Promise<DigitalHumanRuntimeGateResult> | undefined>(undefined)
  const [state, setState] = useState<DigitalHumanRuntimeGateState>({
    status: 'checking',
    canGenerate: false,
    preparing: false,
  })

  const applySnapshot = useCallback((snapshot: RuntimeSnapshot, epoch: number) => {
    if (!mountedRef.current || epochRef.current !== epoch) return
    setState(snapshot.ready
      ? { status: 'ready', canGenerate: true, preparing: false }
      : snapshot.startable
        ? {
            status: 'startable',
            canGenerate: true,
            preparing: false,
            message: snapshot.message,
            action: snapshot.action,
          }
        : {
            status: 'blocked',
            canGenerate: false,
            preparing: false,
            message: snapshot.message,
            action: snapshot.action,
          })
  }, [])

  const inspect = useCallback(async (): Promise<RuntimeSnapshot> => {
    const [readiness, managed] = await Promise.all([
      readinessClient.get(),
      managedClient.get(),
    ])
    const heyGemReady = readiness.status !== 'error'
      && readiness.checks.some((check) => check.id === 'heygem' && check.status === 'ready')
    if (heyGemReady) {
      return { ready: true, startable: true, shouldStart: false }
    }
    if (managed.status === 'error') {
      return blocked(managed.error.message)
    }
    if (managed.runtime.phase === 'ready') {
      return { ready: true, startable: true, shouldStart: false }
    }
    if (managed.runtime.phase === 'stopped' && managed.actions.canStart) {
      return {
        ready: false,
        startable: true,
        shouldStart: true,
        message: '数字人运行环境将在生成时自动启动。',
      }
    }
    if (managed.runtime.phase === 'running') {
      return {
        ready: false,
        startable: true,
        shouldStart: false,
        message: '数字人运行环境正在启动，生成时会等待服务就绪。',
      }
    }
    return blocked(
      managed.runtime.phase === 'absent'
        ? '尚未安装数字人运行环境，请先到设置中导入 KouboRuntime。'
        : managed.runtime.detail || '数字人运行环境当前不可用，请到设置中检查。',
    )
  }, [managedClient, readinessClient])

  const refresh = useCallback(async () => {
    const epoch = ++epochRef.current
    if (mountedRef.current) {
      setState({ status: 'checking', canGenerate: false, preparing: false })
    }
    const snapshot = await inspect().catch(() =>
      blocked('无法检查数字人运行环境，请到设置中重试。'))
    applySnapshot(snapshot, epoch)
    return snapshot
  }, [applySnapshot, inspect])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
      epochRef.current += 1
      ensureRef.current = undefined
    }
  }, [refresh])

  const ensureReady = useCallback((): Promise<DigitalHumanRuntimeGateResult> => {
    if (ensureRef.current) return ensureRef.current
    const epoch = ++epochRef.current
    if (mountedRef.current) {
      setState((current) => ({
        ...current,
        status: 'preparing',
        canGenerate: false,
        preparing: true,
        message: '正在准备数字人运行环境…',
        action: undefined,
      }))
    }

    const operation = (async (): Promise<DigitalHumanRuntimeGateResult> => {
      const cancelled = (): DigitalHumanRuntimeGateResult => ({
        ready: false,
        message: '数字人运行环境准备已取消。',
      })
      const isCurrent = () => mountedRef.current && epochRef.current === epoch

      let snapshot = await inspect().catch(() =>
        blocked('无法检查数字人运行环境，请到设置中重试。'))
      if (!isCurrent()) return cancelled()
      if (snapshot.ready) return { ready: true }
      if (!snapshot.startable) {
        return {
          ready: false,
          message: snapshot.message,
          action: snapshot.action,
        }
      }
      if (snapshot.shouldStart) {
        const startResult = await lifecycleClient.startRuntime()
        if (!isCurrent()) return cancelled()
        if (startResult.status !== 'ok') {
          return {
            ready: false,
            message: startResult.status === 'cancelled'
              ? '数字人运行环境启动已取消，请重试或到设置中检查。'
              : startResult.error.message,
            action: 'open_settings',
          }
        }
      }
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        if (!isCurrent()) return cancelled()
        if (attempt > 0 || snapshot.shouldStart) {
          await wait(pollIntervalMs)
          if (!isCurrent()) return cancelled()
        }
        snapshot = await inspect().catch(() =>
          blocked('无法检查数字人运行环境，请到设置中重试。'))
        if (!isCurrent()) return cancelled()
        if (snapshot.ready) return { ready: true }
        if (!snapshot.startable) {
          return {
            ready: false,
            message: snapshot.message,
            action: snapshot.action,
          }
        }
      }
      return {
        ready: false,
        message: '数字人运行环境启动超时，请到设置中检查服务状态。',
        action: 'open_settings',
      }
    })()

    ensureRef.current = operation
    void operation.then((result) => {
      if (!mountedRef.current || epochRef.current !== epoch) return
      setState(result.ready
        ? { status: 'ready', canGenerate: true, preparing: false }
        : {
            status: 'blocked',
            canGenerate: false,
            preparing: false,
            message: result.message,
            action: result.action,
          })
    }).finally(() => {
      if (ensureRef.current === operation) ensureRef.current = undefined
    })
    return operation
  }, [inspect, lifecycleClient, maxPollAttempts, pollIntervalMs])

  return {
    ...state,
    refresh,
    ensureReady,
  }
}

function blocked(message: string): RuntimeSnapshot {
  return {
    ready: false,
    startable: false,
    shouldStart: false,
    message,
    action: 'open_settings',
  }
}

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
}
