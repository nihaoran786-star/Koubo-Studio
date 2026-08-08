import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  beginProjectStageOperation,
  completeProjectStageOperation,
  failProjectStageOperation,
  getProjectState,
  markProjectStageOperationRunning,
  ProjectStateError,
  reconcileProjectStageOperation,
} from '@/lib/project-state/project-state-service'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { getRenderArtifact } from '@/lib/artifacts/render-artifact'
import { getPostProductionArtifact, savePostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { getScriptArtifact } from '@/lib/artifacts/script-artifact'
import { writeJsonFileAtomically } from '@/lib/artifacts/atomic-json-file'
import { resolveArtifactPath } from '@/lib/artifacts/artifact-manager'
import { listEditMediaAssets } from '@/lib/post-production/edit-media-asset'
import { createDefaultEditPlan, parseEditPlan, type EditPlanV1 } from '@/lib/post-production/edit-plan'
import { generateAiEditPlan } from '@/lib/post-production/edit-plan-agent'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { OpenChatCutMcpClient, toOpenChatCutError } from './mcp-client'
import { readOpenChatCutSettings } from './settings-store'
import {
  exportOpenChatCutVideo,
  importOpenChatCutSource,
  inspectOpenChatCutTranscriptionStatus,
  openOpenChatCutProjectEditor,
  probeOpenChatCutExport,
} from './electron-cdp-adapter'
import {
  inspectOpenChatCutRuntime,
  launchOpenChatCut,
  startOpenChatCutInstallerDownload,
} from './runtime-adapter'
import type {
  OpenChatCutProjectBridge,
  OpenChatCutResult,
  OpenChatCutRuntimeStatus,
} from './types'

const BRIDGE_FILE_NAME = 'openchatcut-bridge.json'
const MCP_START_TIMEOUT_MS = 45_000
const MCP_POLL_INTERVAL_MS = 750
const EDITOR_CONNECTION_TIMEOUT_MS = 30_000
const EDITOR_CONNECTION_POLL_INTERVAL_MS = 400
const CAPTION_READINESS_TIMEOUT_MS = 90_000
const CAPTION_READINESS_POLL_INTERVAL_MS = 1_000
const PROJECT_STABILITY_TIMEOUT_MS = 90_000
const PROJECT_STABILITY_QUIESCENCE_MS = 3_000
const DRAFT_MCP_TRANSPORT_MARGIN_MS = 5_000
const DRAFT_TOOL_TIMEOUT_MS = 8_000
const SESSION_RECONCILE_TIMEOUT_MS = 10_000
const MAX_REQUEST_CHARS = 400

export interface ManagedWaitClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

interface ManagedWaitBudget {
  clock: ManagedWaitClock
  deadline: number
  expired: Promise<ManagedWaitDeadlineOutcome>
  isExpired(): boolean
  release(): void
}

type ManagedWaitDeadlineOutcome = { kind: 'deadline' }
type ManagedWaitObservedOutcome<T> =
  | { kind: 'fulfilled'; value: T; completedAt: number }
  | { kind: 'rejected'; reason: unknown; completedAt: number }
type ManagedWaitOutcome<T> = ManagedWaitDeadlineOutcome | ManagedWaitObservedOutcome<T>

interface ManagedAppLaunchDependencies {
  launch?: typeof launchOpenChatCut
  inspect?: typeof inspectOpenChatCutRuntime
  clock?: ManagedWaitClock
  timeoutMs?: number
  intervalMs?: number
}

interface OpenChatCutSessionDependencies {
  sessionReconcileClock?: ManagedWaitClock
  sessionReconcileTimeoutMs?: number
  editorConnectionClock?: ManagedWaitClock
  editorConnectionTimeoutMs?: number
  editorConnectionIntervalMs?: number
  captionReadinessClock?: ManagedWaitClock
  captionReadinessTimeoutMs?: number
  captionReadinessIntervalMs?: number
  projectStabilityClock?: ManagedWaitClock
  projectStabilityTimeoutMs?: number
  projectStabilityQuiescenceMs?: number
}

interface ManagedLaunchEvidence {
  spawnSucceeded: boolean
  hasSeenLaunching: boolean
}

const systemManagedWaitClock: ManagedWaitClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface PersistedOpenChatCutBridge {
  version: 4
  projectId: string
  phase: OpenChatCutProjectBridge['phase']
  openChatCutProjectId: string
  editorUrl: string
  sourceArtifactKind: OpenChatCutProjectBridge['sourceArtifactKind']
  sourceArtifactId: string
  baseRenderArtifactId: string
  scriptArtifactId: string
  sourceDurationSeconds: number
  request: string
  currentPlan: EditPlanV1
  instructions: string[]
  editSessionId?: string
  exportOperationId?: string
  exportSessionId?: string
  exportedArtifactId?: string
  updatedAt: string
}

const activeExports = new Map<
  string,
  Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>>
>()
const activeExportByProject = new Map<string, string>()
let activeManagedAppLaunch:
  | Promise<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>>
  | undefined

interface ResolvedCurrentVideo {
  sourceVideoUrl: string
  durationSeconds: number
  sourceArtifactKind: OpenChatCutProjectBridge['sourceArtifactKind']
  sourceArtifactId: string
  baseRenderArtifactId: string
  scriptArtifactId: string
  script: string
  currentPlan: EditPlanV1
  sourcePath: string
  cacheDirectory: string
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>
}

class OpenChatCutServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public stage?: string,
    public toolCode?: string,
    public recovery?: {
      action: 'inspect_and_discard'
      editSessionId: string
    },
  ) {
    super(message)
    this.name = 'OpenChatCutServiceError'
  }
}

export async function getOpenChatCutRuntime() {
  const runtime = await inspectOpenChatCutRuntime()
  if (
    activeManagedAppLaunch &&
    runtime.phase === 'installed'
  ) {
    return {
      status: 'ok',
      source: 'openchatcut',
      runtime: {
        ...runtime,
        phase: 'launching' as const,
        detail: '正在启动受管 OpenChatCut，并验证本地剪辑窗口…',
      },
    } as const
  }
  return { status: 'ok', source: 'openchatcut', runtime } as const
}

export async function prepareOpenChatCutRuntime() {
  startOpenChatCutInstallerDownload()
  return { status: 'ok', source: 'openchatcut', runtime: await inspectOpenChatCutRuntime() } as const
}

export function launchOpenChatCutRuntime(
  target: 'installer' | 'app',
  dependencies: ManagedAppLaunchDependencies = {},
): Promise<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>> {
  if (target === 'app') {
    if (activeManagedAppLaunch) return activeManagedAppLaunch
    const task = performManagedAppLaunch(dependencies)
    const wrapped = task.finally(() => {
      if (activeManagedAppLaunch === wrapped) activeManagedAppLaunch = undefined
    })
    activeManagedAppLaunch = wrapped
    return wrapped
  }
  return performInstallerLaunch(dependencies)
}

async function performInstallerLaunch(
  dependencies: {
    launch?: typeof launchOpenChatCut
    inspect?: typeof inspectOpenChatCutRuntime
  },
): Promise<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>> {
  const result = await (dependencies.launch ?? launchOpenChatCut)('installer')
  if (result.status === 'error') return result
  return {
    status: 'ok',
    source: 'openchatcut',
    runtime: await (dependencies.inspect ?? inspectOpenChatCutRuntime)(),
  }
}

async function performManagedAppLaunch(
  dependencies: ManagedAppLaunchDependencies,
): Promise<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>> {
  const inspect = dependencies.inspect ?? inspectOpenChatCutRuntime
  const budget = createManagedWaitBudget(
    dependencies.timeoutMs ?? MCP_START_TIMEOUT_MS,
    dependencies.clock ?? systemManagedWaitClock,
  )
  try {
    const currentOutcome = await observeWithinManagedWaitBudget(inspect, budget)
    if (currentOutcome.kind === 'deadline') return managedStartTimeoutFailure()
    if (currentOutcome.kind === 'rejected') {
      return runtimeInspectionFailure(currentOutcome.reason)
    }
    const current = currentOutcome.value
    if (current.mcpReady) return { status: 'ok', source: 'openchatcut', runtime: current }
    const terminal = classifyManagedRuntimeTerminal(current, false)
    if (terminal) return terminal
    if (current.phase === 'launching') {
      return waitForExistingManagedApp(
        dependencies,
        inspect,
        { spawnSucceeded: false, hasSeenLaunching: true },
        budget,
      )
    }
    if (!current.installed) {
      return failure('app_not_installed', '尚未完整安装 OpenChatCut，请先完成安装。')
    }
    if (current.phase !== 'installed') {
      return failure('runtime_not_launchable', 'OpenChatCut 当前状态无法启动，请刷新后重试。')
    }
    const result = await (dependencies.launch ?? launchOpenChatCut)('app')
    if (result.status === 'error') return result
    if (budget.isExpired()) return managedStartTimeoutFailure()
    return waitForExistingManagedApp(
      dependencies,
      inspect,
      { spawnSucceeded: true, hasSeenLaunching: false },
      budget,
    )
  } finally {
    budget.release()
  }
}

async function waitForExistingManagedApp(
  dependencies: ManagedAppLaunchDependencies,
  inspect: typeof inspectOpenChatCutRuntime,
  launchEvidence: ManagedLaunchEvidence,
  budget: ManagedWaitBudget,
): Promise<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>> {
  const outcome = await waitForOpenChatCutMcpWithinBudget({
    inspect,
    intervalMs: dependencies.intervalMs,
    managedLaunchEvidence: launchEvidence,
    budget,
  })
  if (outcome.kind === 'rejected') return runtimeInspectionFailure(outcome.reason)
  const runtime = outcome.runtime
  if (runtime?.mcpReady) return { status: 'ok', source: 'openchatcut', runtime }
  if (runtime?.phase === 'external_instance') {
    return failure(
      'external_instance',
      '受管 OpenChatCut 启动后，本地 MCP 在等待期内始终无法与受管窗口身份匹配。请关闭所有 OpenChatCut 窗口后重试。',
    )
  }
  if (runtime) {
    const terminal = classifyManagedRuntimeTerminal(runtime, true)
    if (terminal) return terminal
  }
  return managedStartTimeoutFailure()
}

export async function waitForOpenChatCutMcp(input: {
  inspect?: typeof inspectOpenChatCutRuntime
  clock?: ManagedWaitClock
  timeoutMs?: number
  intervalMs?: number
  hasSeenLaunching?: boolean
} = {}): Promise<OpenChatCutRuntimeStatus | undefined> {
  const budget = createManagedWaitBudget(
    input.timeoutMs ?? MCP_START_TIMEOUT_MS,
    input.clock ?? systemManagedWaitClock,
  )
  try {
    const outcome = await waitForOpenChatCutMcpWithinBudget({
      inspect: input.inspect ?? inspectOpenChatCutRuntime,
      intervalMs: input.intervalMs,
      hasSeenLaunching: input.hasSeenLaunching,
      budget,
    })
    if (outcome.kind === 'rejected') throw outcome.reason
    return outcome.runtime
  } finally {
    budget.release()
  }
}

async function waitForOpenChatCutMcpWithinBudget(input: {
  inspect: typeof inspectOpenChatCutRuntime
  intervalMs?: number
  hasSeenLaunching?: boolean
  managedLaunchEvidence?: ManagedLaunchEvidence
  budget: ManagedWaitBudget
}): Promise<
  | { kind: 'completed'; runtime: OpenChatCutRuntimeStatus | undefined }
  | { kind: 'rejected'; reason: unknown }
> {
  const intervalMs = Math.max(1, input.intervalMs ?? MCP_POLL_INTERVAL_MS)
  const hasManagedLaunchEvidence = input.managedLaunchEvidence !== undefined
  const spawnSucceeded = input.managedLaunchEvidence?.spawnSucceeded ?? false
  let hasSeenLaunching = input.managedLaunchEvidence?.hasSeenLaunching
    ?? input.hasSeenLaunching
    ?? false
  let deferredExternal: OpenChatCutRuntimeStatus | undefined
  const timedOut = () => ({
    kind: 'completed' as const,
    runtime: hasManagedLaunchEvidence ? deferredExternal : undefined,
  })
  while (!input.budget.isExpired()) {
    const inspected = await observeWithinManagedWaitBudget(input.inspect, input.budget)
    if (inspected.kind === 'deadline') {
      return timedOut()
    }
    if (inspected.kind === 'rejected') {
      return { kind: 'rejected', reason: inspected.reason }
    }
    const runtime = inspected.value
    if (runtime.mcpReady) return { kind: 'completed', runtime }
    const externalIsTransient =
      runtime.phase === 'external_instance' &&
      hasManagedLaunchEvidence &&
      (spawnSucceeded || hasSeenLaunching)
    if (runtime.phase === 'launching') {
      hasSeenLaunching = true
      deferredExternal = undefined
    } else if (externalIsTransient) {
      deferredExternal = runtime
    } else {
      deferredExternal = undefined
    }
    if (externalIsTransient) {
      // MCP can become ready before the managed CDP page is observable during a cold start.
      // Keep polling only when this service has explicit evidence of the managed launch.
    } else if (classifyManagedRuntimeTerminal(runtime, hasSeenLaunching)) {
      return { kind: 'completed', runtime }
    }
    const remainingMs = input.budget.deadline - input.budget.clock.now()
    if (remainingMs <= 0) return timedOut()
    const slept = await sleepWithinManagedWaitBudget(
      Math.min(intervalMs, remainingMs),
      input.budget,
    )
    if (slept.kind === 'deadline') return timedOut()
    if (slept.kind === 'rejected') return { kind: 'rejected', reason: slept.reason }
  }
  return timedOut()
}

function createManagedWaitBudget(
  timeoutMs: number,
  clock: ManagedWaitClock,
): ManagedWaitBudget {
  const boundedTimeoutMs = Math.max(0, timeoutMs)
  const deadline = clock.now() + boundedTimeoutMs
  let released = false
  let expired = false
  let timerHandle: unknown
  let resolveDeadline!: (outcome: ManagedWaitDeadlineOutcome) => void
  const deadlinePromise = new Promise<ManagedWaitDeadlineOutcome>((resolve) => {
    resolveDeadline = resolve
  })
  timerHandle = clock.setTimeout(() => {
    expired = true
    resolveDeadline({ kind: 'deadline' })
  }, boundedTimeoutMs)
  return {
    clock,
    deadline,
    expired: deadlinePromise,
    isExpired: () => expired || clock.now() >= deadline,
    release: () => {
      if (released) return
      released = true
      clock.clearTimeout(timerHandle)
    },
  }
}

async function observeWithinManagedWaitBudget<T>(
  operation: () => T | PromiseLike<T>,
  budget: ManagedWaitBudget,
): Promise<ManagedWaitOutcome<T>> {
  if (budget.isExpired()) return { kind: 'deadline' }
  const observed = observeManagedWaitOperation(operation, budget.clock)
  const outcome = await Promise.race([observed, budget.expired])
  if (outcome.kind !== 'deadline' && outcome.completedAt > budget.deadline) {
    return { kind: 'deadline' }
  }
  return outcome
}

function observeManagedWaitOperation<T>(
  operation: () => T | PromiseLike<T>,
  clock: ManagedWaitClock,
): Promise<ManagedWaitObservedOutcome<T>> {
  try {
    return Promise.resolve(operation()).then(
      (value) => ({ kind: 'fulfilled', value, completedAt: clock.now() }),
      (reason) => ({ kind: 'rejected', reason, completedAt: clock.now() }),
    )
  } catch (reason) {
    return Promise.resolve({ kind: 'rejected', reason, completedAt: clock.now() })
  }
}

async function sleepWithinManagedWaitBudget(
  milliseconds: number,
  budget: ManagedWaitBudget,
): Promise<ManagedWaitOutcome<void>> {
  let timerHandle: unknown
  const outcome = await observeWithinManagedWaitBudget(
    () => new Promise<void>((resolve) => {
      timerHandle = budget.clock.setTimeout(resolve, milliseconds)
    }),
    budget,
  )
  if (timerHandle !== undefined) budget.clock.clearTimeout(timerHandle)
  return outcome
}

function managedStartTimeoutFailure(): OpenChatCutResult<never> {
  return failure(
    'mcp_start_timeout',
    'OpenChatCut 未能在 45 秒内完成启动和本地 MCP 连接。请确认编辑器没有被防火墙拦截后重试。',
  )
}

function runtimeInspectionFailure(error: unknown): OpenChatCutResult<never> {
  const normalized = normalizeServiceError(error)
  return failure(
    'runtime_inspection_failed',
    `检查 OpenChatCut 运行状态失败：${normalized.message}`,
  )
}

function classifyManagedRuntimeTerminal(
  runtime: OpenChatCutRuntimeStatus,
  installedMeansClosed: boolean,
): OpenChatCutResult<never> | undefined {
  if (runtime.phase === 'external_instance') {
    return failure('external_instance', '检测到另一个 OpenChatCut 实例。请关闭它，再从口播智能体启动。')
  }
  if (runtime.phase === 'failed') {
    return failure(
      runtime.error?.code ?? 'runtime_failed',
      runtime.error?.message ?? runtime.detail,
    )
  }
  if (runtime.phase === 'installing') {
    return failure('install_in_progress', 'OpenChatCut 仍在安装，请等待安装器完成。')
  }
  if (runtime.phase === 'installed' && installedMeansClosed) {
    return failure('managed_window_closed', 'OpenChatCut 窗口已退出，本地 MCP 未能连接。请重新启动。')
  }
  if (
    runtime.phase === 'not_installed' ||
    runtime.phase === 'installer_ready' ||
    runtime.phase === 'downloading'
  ) {
    return failure('app_not_installed', 'OpenChatCut 安装当前不可用，请完成安装后重试。')
  }
  return undefined
}

export async function getOpenChatCutProject(
  projectId: string,
): Promise<OpenChatCutResult<{
  bridge?: OpenChatCutProjectBridge
  stale?: boolean
  detail?: string
}>> {
  try {
    const safeProjectId = assertSafeSegment(projectId, 'projectId')
    const workspace = await ensureProjectWorkspace(safeProjectId, 'digital-human')
    let persisted = await readPersistedBridge(workspace)
    if (persisted?.phase === 'exporting') {
      const context = await resolveBridgeSourceVideo(safeProjectId)
      const reconciled = await reconcileExportState(context.video, persisted)
      if (reconciled.status === 'conflict') {
        return {
          status: 'ok',
          source: 'openchatcut',
          stale: true,
          detail: reconciled.detail,
        }
      }
      persisted = reconciled.bridge
    }
    const current = await resolveCurrentVideo(projectId)
    if (!persisted) return { status: 'ok', source: 'openchatcut' }
    const project = await getProjectState(projectId)
    const bridgeOperationOwnsEdit =
      (persisted.phase === 'exporting' || persisted.phase === 'applied') &&
      (project.stages.edit.status === 'queued' ||
        project.stages.edit.status === 'running' ||
        project.stages.edit.status === 'failed') &&
      project.stages.edit.source === 'openchatcut' &&
      project.stages.edit.operation?.upstreamArtifactId === persisted.baseRenderArtifactId
    if (
      persisted.projectId !== current.workspace.projectId ||
      persisted.baseRenderArtifactId !== current.baseRenderArtifactId ||
      (!bridgeOperationOwnsEdit &&
        persisted.sourceArtifactId !== current.sourceArtifactId &&
        persisted.exportedArtifactId !== current.sourceArtifactId) ||
      persisted.scriptArtifactId !== current.scriptArtifactId
    ) {
      return {
        status: 'ok',
        source: 'openchatcut',
        stale: true,
        detail: '先前的专业剪辑项目属于旧文案或旧视频，请重新创建。',
      }
    }
    return {
      status: 'ok',
      source: 'openchatcut',
      bridge: toPublicBridge(
        persisted,
        bridgeOperationOwnsEdit ? bridgeSourceVideoUrl(persisted) : current.sourceVideoUrl,
      ),
    }
  } catch (error) {
    return { status: 'error', source: 'openchatcut', error: normalizeServiceError(error) }
  }
}

function bridgeSourceVideoUrl(bridge: PersistedOpenChatCutBridge) {
  const suffix = bridge.sourceArtifactKind === 'render'
    ? `/render-artifacts/${encodeURIComponent(bridge.sourceArtifactId)}/file`
    : `/post-production-artifacts/${encodeURIComponent(bridge.sourceArtifactId)}/file`
  return buildProjectApiEndpoint(bridge.projectId, suffix)
}

export async function createOpenChatCutProject(
  projectId: string,
): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  try {
    await ensureOpenChatCutReady()
    const input = await resolveCurrentVideo(projectId)
    const project = await getProjectState(projectId)
    const client = await connectedClient()
    const created = assertToolOk(await client.callTool('create_project', {
      name: `${project.title} · 专业精剪`,
      description: '由口播智能体创建。请在可见编辑器中导入当前视频，完成后再生成 AI 草案。',
      compositionWidth: 1080,
      compositionHeight: 1920,
      fps: 30,
    }))
    const openChatCutProjectId = assertSafeSegment(requiredString(created, 'id'), 'openChatCutProjectId')
    assertToolOk(await client.callTool('target_project', { projectId: openChatCutProjectId }))
    const editor = assertToolOk(await client.callTool('get_editor_url', { projectId: openChatCutProjectId }))
    const instructions = [
      'OpenChatCut 已创建 9:16 空项目。',
      '请打开剪辑台，导入当前视频并拖到主视频轨。',
      '导入完成后回到这里输入精剪要求并生成 AI 草案。',
    ]
    const persisted: PersistedOpenChatCutBridge = {
      version: 4,
      projectId: input.workspace.projectId,
      phase: 'needs_user_import',
      openChatCutProjectId,
      editorUrl: safeEditorUrl(requiredString(editor, 'editorUrl'), openChatCutProjectId),
      sourceArtifactKind: input.sourceArtifactKind,
      sourceArtifactId: input.sourceArtifactId,
      baseRenderArtifactId: input.baseRenderArtifactId,
      scriptArtifactId: input.scriptArtifactId,
      sourceDurationSeconds: input.durationSeconds,
      request: '',
      currentPlan: input.currentPlan,
      instructions,
      updatedAt: new Date().toISOString(),
    }
    await saveBridge(input.workspace, persisted)
    return {
      status: 'ok',
      source: 'openchatcut',
      bridge: toPublicBridge(persisted, input.sourceVideoUrl),
    }
  } catch (error) {
    return { status: 'error', source: 'openchatcut', error: normalizeServiceError(error) }
  }
}

export async function runOpenChatCutSession(input: {
  projectId: string
  action: 'import' | 'begin' | 'status' | 'review' | 'discard' | 'export'
  openChatCutProjectId: string
  editSessionId?: string
  request?: string
}, dependencies: OpenChatCutSessionDependencies = {}): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  try {
    await ensureOpenChatCutReady()
    const context = input.action === 'export'
      ? await resolveBridgeSourceVideo(input.projectId)
      : undefined
    const video = context?.video ?? await resolveCurrentVideo(input.projectId)
    const persisted = context?.persisted ?? await requireCurrentBridge(video)
    const projectId = assertSafeSegment(input.openChatCutProjectId, 'openChatCutProjectId')
    if (persisted.openChatCutProjectId !== projectId) {
      throw new OpenChatCutServiceError('bridge_project_mismatch', '专业剪辑项目与当前 workspace 记录不一致，请重新创建。')
    }
    const client = await connectedClient(
      input.action === 'begin'
        ? draftMcpTransportTimeout(dependencies)
        : undefined,
    )
    const isDiscardReconcile =
      input.action === 'status' &&
      persisted.phase === 'drafting'
    if (isDiscardReconcile) {
      const editSessionId = assertSafeSegment(
        input.editSessionId ?? persisted.editSessionId ?? '',
        'editSessionId',
      )
      if (persisted.editSessionId !== editSessionId) {
        throw sessionReconcileUnconfirmed()
      }
      const next = await reconcileDiscardedDraftSession({
        client,
        video,
        persisted,
        projectId,
        editSessionId,
        dependencies,
      })
      return {
        status: 'ok',
        source: 'openchatcut',
        bridge: toPublicBridge(next, video.sourceVideoUrl),
      }
    }
    if (input.action === 'begin') {
      await callDraftTool(
        client,
        'draft_prepare',
        'target_project',
        'target_project',
        { projectId },
      )
    } else {
      assertToolOk(await client.callTool('target_project', { projectId }))
    }

    if (input.action === 'import') {
      return await importCurrentVideo({ client, video, persisted, projectId, dependencies })
    }
    if (input.action === 'begin') {
      return await beginAiDraft({
        client,
        video,
        persisted,
        projectId,
        request: normalizeRequest(input.request),
        dependencies,
      })
    }
    if (input.action === 'export') {
      return await exportAppliedVideo({ video, persisted, projectId })
    }

    const editSessionId = assertSafeSegment(
      input.editSessionId ?? persisted.editSessionId ?? '',
      'editSessionId',
    )
    let result: Record<string, unknown>
    if (input.action === 'status') {
      result = await readEditSessionStatusWithDurableFallback(
        client,
        projectId,
        editSessionId,
      )
    } else if (input.action === 'review') {
      result = assertToolOk(await client.callTool('review_edit_session', {
        editorProjectId: projectId,
        editSessionId,
        summary: '口播智能体生成的画幅与镜头节奏草案',
      }))
    } else {
      result = await discardSessionWithExactConfirmation(
        client,
        projectId,
        editSessionId,
      )
    }
    const remoteStatus = stringValue(result.status)
    const phase = input.action === 'discard'
      ? 'discarded'
      : input.action === 'review'
        ? 'needs_review'
        : sessionPhase(remoteStatus)
    let next: PersistedOpenChatCutBridge
    if (input.action === 'discard') {
      try {
        next = {
          ...persisted,
          phase: 'discarded',
          editorUrl: safeEditorUrl(persisted.editorUrl, projectId),
          editSessionId,
          instructions: instructionsFor('discarded'),
          updatedAt: new Date().toISOString(),
        }
        await saveBridge(video.workspace, next)
      } catch {
        throw new OpenChatCutServiceError(
          'bridge_persist_failed',
          '草案会话结果无法保存。请在可见编辑器中检查当前会话状态。',
          'session_discard',
          'bridge_persist',
        )
      }
    } else {
      next = await updatedPersistedBridge(client, persisted, {
        phase,
        projectId,
        editSessionId,
        instructions: instructionsFor(phase),
      })
      await saveBridge(video.workspace, next)
    }
    return {
      status: 'ok',
      source: 'openchatcut',
      bridge: toPublicBridge(next, video.sourceVideoUrl),
    }
  } catch (error) {
    return { status: 'error', source: 'openchatcut', error: normalizeServiceError(error) }
  }
}

async function reconcileDiscardedDraftSession(input: {
  client: OpenChatCutMcpClient
  video: ResolvedCurrentVideo
  persisted: PersistedOpenChatCutBridge
  projectId: string
  editSessionId: string
  dependencies: OpenChatCutSessionDependencies
}) {
  const budget = createManagedWaitBudget(
    input.dependencies.sessionReconcileTimeoutMs ?? SESSION_RECONCILE_TIMEOUT_MS,
    input.dependencies.sessionReconcileClock ?? systemManagedWaitClock,
  )
  try {
    const target = await observeWithinManagedWaitBudget(
      () => input.client.callTool(
        'target_project',
        { projectId: input.projectId },
        { timeoutMs: reconcileToolTimeout(budget) },
      ),
      budget,
    )
    if (
      target.kind !== 'fulfilled' ||
      target.value.projectId !== input.projectId
    ) {
      throw sessionReconcileUnconfirmed()
    }
    const session = await observeWithinManagedWaitBudget(
      () => input.client.callTool(
        'get_edit_session',
        {
          editorProjectId: input.projectId,
          editSessionId: input.editSessionId,
        },
        { timeoutMs: reconcileToolTimeout(budget) },
      ),
      budget,
    )
    if (
      session.kind !== 'fulfilled' ||
      session.value.editSessionId !== input.editSessionId ||
      session.value.status !== 'discarded'
    ) {
      throw sessionReconcileUnconfirmed()
    }
    try {
      const next = {
        ...input.persisted,
        phase: 'discarded' as const,
        editorUrl: safeEditorUrl(input.persisted.editorUrl, input.projectId),
        editSessionId: input.editSessionId,
        instructions: instructionsFor('discarded'),
        updatedAt: new Date().toISOString(),
      }
      await saveBridge(input.video.workspace, next)
      return next
    } catch {
      throw new OpenChatCutServiceError(
        'bridge_persist_failed',
        '草案会话对账结果无法保存。请在可见编辑器中检查当前会话状态。',
        'session_reconcile',
        'bridge_persist',
      )
    }
  } catch (error) {
    if (
      error instanceof OpenChatCutServiceError &&
      error.code === 'bridge_persist_failed'
    ) {
      throw error
    }
    throw sessionReconcileUnconfirmed()
  } finally {
    budget.release()
  }
}

function reconcileToolTimeout(budget: ManagedWaitBudget) {
  return Math.max(
    1,
    Math.min(DRAFT_TOOL_TIMEOUT_MS, budget.deadline - budget.clock.now()),
  )
}

function sessionReconcileUnconfirmed() {
  return new OpenChatCutServiceError(
    'session_reconcile_unconfirmed',
    '未能确认远端草案会话已安全放弃。请在可见编辑器中检查当前会话状态。',
    'session_reconcile',
    'get_edit_session',
  )
}

async function discardSessionWithExactConfirmation(
  client: OpenChatCutMcpClient,
  projectId: string,
  editSessionId: string,
) {
  try {
    const result = assertToolOk(await client.callTool('discard_edit_session', {
      editorProjectId: projectId,
      editSessionId,
    }))
    if (!isExactDiscardConfirmation(result, editSessionId)) {
      throw unconfirmedSessionDiscard(editSessionId)
    }
    return result
  } catch (error) {
    if (
      error instanceof OpenChatCutServiceError &&
      error.code === 'session_discard_unconfirmed'
    ) {
      throw error
    }
    throw unconfirmedSessionDiscard(editSessionId)
  }
}

function isExactDiscardConfirmation(
  result: Record<string, unknown>,
  editSessionId: string,
) {
  return (
    typeof result.editSessionId === 'string' &&
    result.editSessionId === editSessionId &&
    typeof result.status === 'string' &&
    result.status === 'discarded'
  )
}

function unconfirmedSessionDiscard(editSessionId: string) {
  return new OpenChatCutServiceError(
    'session_discard_unconfirmed',
    '专业剪辑器未能确认草案已放弃。请在可见编辑器中检查当前会话状态。',
    'session_discard',
    'discard_edit_session',
    {
      action: 'inspect_and_discard',
      editSessionId,
    },
  )
}

async function readEditSessionStatusWithDurableFallback(
  client: OpenChatCutMcpClient,
  projectId: string,
  editSessionId: string,
) {
  try {
    return assertToolOk(await client.callTool('get_edit_session', {
      editorProjectId: projectId,
      editSessionId,
    }))
  } catch (error) {
    let durable: Awaited<ReturnType<OpenChatCutMcpClient['getDurableEditSessionStatus']>>
    try {
      durable = await client.getDurableEditSessionStatus(
        projectId,
        editSessionId,
        { timeoutMs: DRAFT_TOOL_TIMEOUT_MS },
      )
    } catch {
      throw error
    }
    if (
      !durable ||
      ![
        'applied',
        'rejected',
        'discarded',
        'awaiting_review',
        'pending_review',
        'review',
      ].includes(durable.status)
    ) {
      throw error
    }
    return durable
  }
}

async function importCurrentVideo(input: {
  client: OpenChatCutMcpClient
  video: ResolvedCurrentVideo
  persisted: PersistedOpenChatCutBridge
  projectId: string
  dependencies: OpenChatCutSessionDependencies
}): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  const settings = await readOpenChatCutSettings()
  if (!settings.cdpPort) {
    throw new OpenChatCutServiceError('cdp_port_missing', '请从口播智能体重新启动 OpenChatCut 后再自动导入。')
  }
  await openOpenChatCutProjectEditor({
    cdpPort: settings.cdpPort,
    editorUrl: input.persisted.editorUrl,
    openChatCutProjectId: input.projectId,
  })
  await waitForOpenChatCutProjectConnection(
    input.client,
    input.projectId,
    input.dependencies,
  )
  const overview = await readProjectInDiscardedManualSession(input.client, input.projectId)
  if (videoItems(overview).length !== 0) {
    throw new OpenChatCutServiceError(
      'timeline_not_empty',
      '时间线已包含媒体，自动导入不会覆盖现有内容；请在剪辑台确认后手动接管。',
    )
  }
  await importOpenChatCutSource({
    cdpPort: settings.cdpPort,
    editorUrl: input.persisted.editorUrl,
    openChatCutProjectId: input.projectId,
    workspaceRoot: input.video.workspace.rootPath,
    sourcePath: input.video.sourcePath,
    timelineEmptyConfirmed: true,
  })

  const verifier = await connectedClient()
  const targeted = assertToolOk(await verifier.callTool('target_project', {
    projectId: input.projectId,
  }))
  if (requiredString(targeted, 'projectId') !== input.projectId) {
    throw new OpenChatCutServiceError(
      'project_identity_mismatch',
      'OpenChatCut 新连接指向了其他项目，已停止导入校验。',
    )
  }
  const verified = await readProjectInDiscardedManualSession(verifier, input.projectId)
  assertImportedVideo(verified, input.video.durationSeconds)
  const next = {
    ...input.persisted,
    phase: 'ready_to_draft' as const,
    instructions: ['当前视频已自动导入并完成媒体校验，可以生成 AI 精剪草案。'],
    updatedAt: new Date().toISOString(),
  }
  await saveBridge(input.video.workspace, next)
  return { status: 'ok', source: 'openchatcut', bridge: toPublicBridge(next, input.video.sourceVideoUrl) }
}

async function readProjectInDiscardedManualSession(
  client: OpenChatCutMcpClient,
  projectId: string,
) {
  const begun = assertToolOk(await client.callTool('begin_edit_session', {
    editorProjectId: projectId,
    clientName: '口播智能体导入校验',
    approvalMode: 'manual',
  }))
  const editSessionId = assertSafeSegment(
    requiredString(begun, 'editSessionId'),
    'editSessionId',
  )
  try {
    return assertToolOk(await client.callTool('read_project', {
      editorProjectId: projectId,
      editSessionId,
      view: 'timeline',
    }))
  } finally {
    assertToolOk(await client.callTool('discard_edit_session', {
      editorProjectId: projectId,
      editSessionId,
    }))
  }
}

async function waitForOpenChatCutProjectConnection(
  client: OpenChatCutMcpClient,
  projectId: string,
  dependencies: OpenChatCutSessionDependencies,
) {
  const budget = createManagedWaitBudget(
    dependencies.editorConnectionTimeoutMs ?? EDITOR_CONNECTION_TIMEOUT_MS,
    dependencies.editorConnectionClock ?? systemManagedWaitClock,
  )
  const intervalMs = Math.max(
    1,
    dependencies.editorConnectionIntervalMs ?? EDITOR_CONNECTION_POLL_INTERVAL_MS,
  )
  try {
    while (!budget.isExpired()) {
      const observed = await observeWithinManagedWaitBudget(
        () => client.callTool('openchatcut_status'),
        budget,
      )
      if (observed.kind === 'deadline') throw editorConnectionTimeout()
      if (observed.kind === 'rejected') throw observed.reason
      const status = assertToolOk(observed.value)
      if (
        !Array.isArray(status.connectedProjectIds) ||
        !status.connectedProjectIds.every((value) => typeof value === 'string' && value.trim())
      ) {
        throw new OpenChatCutServiceError(
          'editor_status_invalid',
          'OpenChatCut 返回了无效的编辑器连接状态，请重新启动剪辑器后重试。',
        )
      }
      const connectedProjectIds = status.connectedProjectIds.map((value) => value.trim())
      if (connectedProjectIds.includes(projectId)) return
      const remainingMs = budget.deadline - budget.clock.now()
      if (remainingMs <= 0) throw editorConnectionTimeout()
      const slept = await sleepWithinManagedWaitBudget(
        Math.min(intervalMs, remainingMs),
        budget,
      )
      if (slept.kind === 'deadline') throw editorConnectionTimeout()
      if (slept.kind === 'rejected') throw slept.reason
    }
    throw editorConnectionTimeout()
  } finally {
    budget.release()
  }
}

function editorConnectionTimeout() {
  return new OpenChatCutServiceError(
    'editor_connection_timeout',
    'OpenChatCut 编辑器未能在 30 秒内连接当前项目，请确认可见剪辑窗口已打开后重试。',
  )
}

async function exportAppliedVideo(input: {
  video: ResolvedCurrentVideo
  persisted: PersistedOpenChatCutBridge
  projectId: string
}): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  if (input.persisted.phase === 'exporting') {
    const reconciled = await reconcileExportState(input.video, input.persisted)
    if (reconciled.status === 'conflict') {
      throw new OpenChatCutServiceError('export_operation_conflict', reconciled.detail)
    }
    return exportBridgeResult(input.video, reconciled.bridge)
  }
  if (input.persisted.phase === 'exported') {
    return exportBridgeResult(input.video, input.persisted)
  }
  if (input.persisted.phase !== 'applied') {
    throw new OpenChatCutServiceError('draft_not_applied', '请先在 OpenChatCut 中批准草案，再自动导出。')
  }
  const activeKey = activeExportByProject.get(input.video.workspace.projectId)
  const active = activeKey ? activeExports.get(activeKey) : undefined
  if (active) return active

  const artifactId = `openchatcut-${randomUUID()}`
  const sessionId = `openchatcut-export-${randomUUID()}`
  const key = exportKey(input.video.workspace.projectId, artifactId)
  const task = Promise.resolve().then(() => performExportAppliedVideo({
    ...input,
    artifactId,
    sessionId,
  }))
  activeExportByProject.set(input.video.workspace.projectId, key)
  activeExports.set(key, task)
  void task.finally(() => {
    if (activeExports.get(key) === task) activeExports.delete(key)
    if (activeExportByProject.get(input.video.workspace.projectId) === key) {
      activeExportByProject.delete(input.video.workspace.projectId)
    }
  }).catch(() => undefined)
  return task
}

async function performExportAppliedVideo(input: {
  video: ResolvedCurrentVideo
  persisted: PersistedOpenChatCutBridge
  projectId: string
  artifactId: string
  sessionId: string
}): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  const settings = await readOpenChatCutSettings()
  if (!settings.cdpPort) {
    throw new OpenChatCutServiceError('cdp_port_missing', '请从口播智能体重新启动 OpenChatCut 后再自动导出。')
  }
  const exporting = {
    ...input.persisted,
    phase: 'exporting' as const,
    exportOperationId: input.artifactId,
    exportSessionId: input.sessionId,
    exportedArtifactId: undefined,
    instructions: ['正在从 OpenChatCut 导出并校验 MP4，请保持剪辑器窗口打开。'],
    updatedAt: new Date().toISOString(),
  }
  await saveBridge(input.video.workspace, exporting)
  try {
    await beginProjectStageOperation({
      projectId: input.video.workspace.projectId,
      stage: 'edit',
      operationId: input.artifactId,
      sessionId: input.sessionId,
      source: 'openchatcut',
      expectedUpstreamArtifactId: input.video.baseRenderArtifactId,
    })
    await markProjectStageOperationRunning({
      projectId: input.video.workspace.projectId,
      stage: 'edit',
      operationId: input.artifactId,
    })
    const exported = await exportOpenChatCutVideo({
      cdpPort: settings.cdpPort,
      editorUrl: input.persisted.editorUrl,
      openChatCutProjectId: input.projectId,
      workspaceRoot: input.video.workspace.rootPath,
      artifactId: input.artifactId,
    })
    await saveExportArtifact(input.video, exporting, exported.outputPath, exported.durationSeconds)
    await completeProjectStageOperation({
      projectId: input.video.workspace.projectId,
      stage: 'edit',
      operationId: input.artifactId,
      artifactId: input.artifactId,
    })
    const next = exportedBridge(exporting)
    await saveBridge(input.video.workspace, next)
    return exportBridgeResult(input.video, next)
  } catch (error) {
    const durable = await readPersistedBridge(input.video.workspace).catch(() => undefined)
    if (
      durable?.phase === 'exporting' &&
      durable.exportOperationId === input.artifactId &&
      durable.exportSessionId === input.sessionId
    ) {
      const reconciled = await reconcileExportState(input.video, durable, {
        ignoreActiveKey: exportKey(input.video.workspace.projectId, input.artifactId),
        failure: normalizeServiceError(error),
      }).catch(() => undefined)
      if (reconciled?.status === 'ok' && reconciled.bridge.phase === 'exported') {
        return exportBridgeResult(input.video, reconciled.bridge)
      }
    }
    throw error
  }
}

async function reconcileExportState(
  video: ResolvedCurrentVideo,
  persisted: PersistedOpenChatCutBridge,
  options: {
    ignoreActiveKey?: string
    failure?: { code: string; message: string }
  } = {},
): Promise<
  | { status: 'ok'; bridge: PersistedOpenChatCutBridge }
  | { status: 'conflict'; detail: string }
> {
  if (persisted.phase !== 'exporting') return { status: 'ok', bridge: persisted }
  const operationId = persisted.exportOperationId
  const sessionId = persisted.exportSessionId
  if (!operationId || !sessionId) {
    return { status: 'conflict', detail: '专业剪辑导出记录缺少任务身份，请重新创建。' }
  }
  const project = await getProjectState(video.workspace.projectId)
  const stage = project.stages.edit
  const matches =
    stage.source === 'openchatcut' &&
    stage.operation?.id === operationId &&
    stage.operation.sessionId === sessionId &&
    stage.operation.upstreamArtifactId === persisted.baseRenderArtifactId
  if (!matches) {
    return {
      status: 'conflict',
      detail: '当前剪辑阶段已由其他任务更新，旧的 OpenChatCut 导出不会覆盖它。',
    }
  }
  if (stage.status === 'ready') {
    if (stage.artifactId !== operationId) {
      return { status: 'conflict', detail: '当前成片不属于这次 OpenChatCut 导出。' }
    }
    const artifactValidation = await validateRecoveredExportArtifact(video, persisted)
    if (artifactValidation.status !== 'valid') {
      return { status: 'conflict', detail: '当前 OpenChatCut 成片记录无法通过媒体或 lineage 校验。' }
    }
    const next = exportedBridge(persisted)
    await saveBridge(video.workspace, next)
    return { status: 'ok', bridge: next }
  }
  if (stage.status === 'failed') {
    const next = appliedBridge(persisted, stage.error?.message)
    await saveBridge(video.workspace, next)
    return { status: 'ok', bridge: next }
  }
  if (stage.status !== 'queued' && stage.status !== 'running') {
    return { status: 'conflict', detail: '当前剪辑阶段不再属于这次 OpenChatCut 导出。' }
  }

  const key = exportKey(video.workspace.projectId, operationId)
  if (key !== options.ignoreActiveKey && activeExports.has(key)) {
    return { status: 'ok', bridge: persisted }
  }

  let artifactValidation = await validateRecoveredExportArtifact(video, persisted)
  let artifact = artifactValidation.status === 'valid' ? artifactValidation.artifact : undefined
  if (artifactValidation.status === 'missing') {
    const outputPath = expectedExportPath(video.workspace, operationId)
    const probed = await probeRecoveredExport(outputPath)
    if (probed) {
      await saveExportArtifact(video, persisted, outputPath, probed.durationSeconds)
      artifactValidation = await validateRecoveredExportArtifact(video, persisted)
      artifact = artifactValidation.status === 'valid' ? artifactValidation.artifact : undefined
    }
  }
  if (artifact) {
    await reconcileProjectStageOperation({
      projectId: video.workspace.projectId,
      stage: 'edit',
      task: {
        status: 'ready',
        operationId,
        sessionId,
        source: 'openchatcut',
        artifactId: operationId,
      },
    })
    const latest = await getProjectState(video.workspace.projectId)
    if (
      latest.stages.edit.status !== 'ready' ||
      latest.stages.edit.source !== 'openchatcut' ||
      latest.stages.edit.artifactId !== operationId ||
      latest.stages.edit.operation?.id !== operationId ||
      latest.stages.edit.operation.sessionId !== sessionId
    ) {
      return { status: 'conflict', detail: '当前剪辑阶段在恢复期间已被其他任务更新。' }
    }
    const next = exportedBridge(persisted)
    await saveBridge(video.workspace, next)
    return { status: 'ok', bridge: next }
  }

  await failProjectStageOperation({
    projectId: video.workspace.projectId,
    stage: 'edit',
    operationId,
    error: {
      code: 'export_interrupted',
      message: options.failure?.message
        ? `OpenChatCut 导出未完成：${options.failure.message}`
        : 'OpenChatCut 导出曾被中断，未发现可恢复的完整成片。',
    },
  })
  const next = appliedBridge(persisted)
  await saveBridge(video.workspace, next)
  return { status: 'ok', bridge: next }
}

async function validateRecoveredExportArtifact(
  video: ResolvedCurrentVideo,
  persisted: PersistedOpenChatCutBridge,
): Promise<
  | { status: 'valid'; artifact: Awaited<ReturnType<typeof getPostProductionArtifact>> }
  | { status: 'missing' }
  | { status: 'invalid' }
> {
  if (!persisted.exportOperationId || !persisted.exportSessionId) return { status: 'invalid' }
  const artifactPath = resolveArtifactPath(
    video.workspace,
    'post-production',
    `${persisted.exportOperationId}.json`,
  )
  let artifact: Awaited<ReturnType<typeof getPostProductionArtifact>>
  try {
    artifact = await getPostProductionArtifact(video.workspace, persisted.exportOperationId)
  } catch {
    try {
      await fs.access(artifactPath)
      return { status: 'invalid' }
    } catch (error) {
      return isFileNotFoundError(error) ? { status: 'missing' } : { status: 'invalid' }
    }
  }
  if (
    artifact.status !== 'ready' ||
    artifact.source !== 'openchatcut' ||
    artifact.sessionId !== persisted.exportSessionId ||
    artifact.renderArtifactId !== persisted.baseRenderArtifactId ||
    artifact.scriptArtifactId !== persisted.scriptArtifactId ||
    path.resolve(artifact.outputPath) !== path.resolve(expectedExportPath(video.workspace, persisted.exportOperationId))
  ) return { status: 'invalid' }
  const probed = await probeRecoveredExport(artifact.outputPath)
  if (!probed) return { status: 'invalid' }
  const tolerance = Math.max(0.5, artifact.durationSeconds * 0.01)
  if (Math.abs(probed.durationSeconds - artifact.durationSeconds) > tolerance) {
    return { status: 'invalid' }
  }
  return { status: 'valid', artifact }
}

async function probeRecoveredExport(filePath: string) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size <= 0) return undefined
    const probed = await probeOpenChatCutExport(filePath)
    if (
      probed.codec !== 'h264' ||
      !Number.isFinite(probed.durationSeconds) ||
      probed.durationSeconds <= 0
    ) return undefined
    return probed
  } catch {
    return undefined
  }
}

function isFileNotFoundError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function saveExportArtifact(
  video: ResolvedCurrentVideo,
  persisted: PersistedOpenChatCutBridge,
  outputPath: string,
  durationSeconds: number,
) {
  const artifactId = persisted.exportOperationId
  const sessionId = persisted.exportSessionId
  if (!artifactId || !sessionId) {
    throw new OpenChatCutServiceError('export_identity_missing', 'OpenChatCut 导出任务身份缺失。')
  }
  await savePostProductionArtifact({
    workspace: video.workspace,
    artifactId,
    sessionId,
    status: 'ready',
    source: 'openchatcut',
    renderArtifactId: video.baseRenderArtifactId,
    scriptArtifactId: video.scriptArtifactId,
    outputPath,
    durationSeconds,
    parameters: {
      plan: persisted.currentPlan,
      request: persisted.request,
    },
    skillCall: {
      skillId: 'builtin:openchatcut-professional',
      skillName: 'openchatcut-professional',
    },
  })
}

function expectedExportPath(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  artifactId: string,
) {
  return resolveArtifactPath(workspace, 'post-production', `${artifactId}.mp4`)
}

function exportedBridge(persisted: PersistedOpenChatCutBridge): PersistedOpenChatCutBridge {
  if (!persisted.exportOperationId || !persisted.exportSessionId) {
    throw new OpenChatCutServiceError('export_identity_missing', 'OpenChatCut 导出任务身份缺失。')
  }
  return {
    ...persisted,
    phase: 'exported',
    exportedArtifactId: persisted.exportOperationId,
    instructions: ['专业精剪成片已导回当前项目，可以直接预览并继续发布准备。'],
    updatedAt: new Date().toISOString(),
  }
}

function appliedBridge(
  persisted: PersistedOpenChatCutBridge,
  detail?: string,
): PersistedOpenChatCutBridge {
  const next = {
    ...persisted,
    phase: 'applied' as const,
    instructions: [
      detail
        ? `上次自动导出未完成：${detail}。可以重新导出。`
        : '上次自动导出被中断且没有可恢复成片，可以重新导出。',
    ],
    updatedAt: new Date().toISOString(),
  }
  delete next.exportOperationId
  delete next.exportSessionId
  delete next.exportedArtifactId
  return next
}

function exportBridgeResult(
  video: ResolvedCurrentVideo,
  bridge: PersistedOpenChatCutBridge,
): OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }> {
  const videoUrl = bridge.phase === 'exported' && bridge.exportedArtifactId
    ? buildProjectApiEndpoint(
        video.workspace.projectId,
        `/post-production-artifacts/${encodeURIComponent(bridge.exportedArtifactId)}/file`,
      )
    : video.sourceVideoUrl
  return { status: 'ok', source: 'openchatcut', bridge: toPublicBridge(bridge, videoUrl) }
}

function exportKey(projectId: string, operationId: string) {
  return `${projectId}:${operationId}`
}

type DraftToolStage = 'draft_prepare' | 'draft_apply' | 'draft_cleanup'
type DraftToolCode =
  | 'target_project'
  | 'manage_timelines'
  | 'edit_item_validate'
  | 'edit_item_apply'
  | 'edit_captions'
  | 'review_edit_session'
  | 'get_editor_url'
  | 'discard_edit_session'
  | 'bridge_persist'

const SAFE_DRAFT_TOOL_ERROR_CODES = new Set([
  'auth_error',
  'http_error',
  'invalid_response',
  'mcp_session_expired',
  'mcp_timeout',
  'network_error',
  'not_connected',
  'rpc_error',
  'session_missing',
  'tool_error',
  'tool_not_allowed',
  'unexpected_error',
])

function safeDraftToolError(error: unknown) {
  const normalized = normalizeServiceError(error)
  const code = SAFE_DRAFT_TOOL_ERROR_CODES.has(normalized.code)
    ? normalized.code
    : 'unexpected_error'
  const message = code === 'mcp_timeout'
    ? '专业剪辑器草案操作超时。'
    : code === 'auth_error'
      ? '专业剪辑器授权失败，草案操作已停止。'
      : code === 'network_error'
        ? '无法连接专业剪辑器，草案操作已停止。'
        : code === 'mcp_session_expired' ||
            code === 'session_missing' ||
            code === 'not_connected'
          ? '专业剪辑器会话不可用，草案操作已停止。'
          : '专业剪辑器未能完成受控草案操作。'
  return { code, message }
}

async function callDraftTool(
  client: OpenChatCutMcpClient,
  stage: DraftToolStage,
  toolCode: DraftToolCode,
  toolName: string,
  args: Record<string, unknown>,
) {
  try {
    return assertToolOk(await client.callTool(
      toolName,
      args,
      { timeoutMs: DRAFT_TOOL_TIMEOUT_MS },
    ))
  } catch (error) {
    const normalized = safeDraftToolError(error)
    throw new OpenChatCutServiceError(
      normalized.code,
      normalized.message,
      stage,
      toolCode,
    )
  }
}

async function submitDraftForManualReview(input: {
  client: OpenChatCutMcpClient
  projectId: string
  editSessionId: string
  summary: string
}) {
  try {
    await callDraftTool(
      input.client,
      'draft_apply',
      'review_edit_session',
      'review_edit_session',
      {
        editorProjectId: input.projectId,
        editSessionId: input.editSessionId,
        summary: input.summary,
      },
    )
  } catch (error) {
    if (!(error instanceof OpenChatCutServiceError) || error.code !== 'mcp_timeout') {
      throw error
    }
    let durable: Awaited<ReturnType<OpenChatCutMcpClient['getDurableEditSessionStatus']>>
    try {
      durable = await input.client.getDurableEditSessionStatus(
        input.projectId,
        input.editSessionId,
        { timeoutMs: DRAFT_TOOL_TIMEOUT_MS },
      )
    } catch {
      throw error
    }
    if (
      durable?.editSessionId !== input.editSessionId ||
      sessionPhase(durable.status) !== 'needs_review'
    ) {
      throw error
    }
  }
}

async function beginAiDraft(input: {
  client: OpenChatCutMcpClient
  video: ResolvedCurrentVideo
  persisted: PersistedOpenChatCutBridge
  projectId: string
  request: string
  dependencies: OpenChatCutSessionDependencies
}): Promise<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>> {
  let editSessionId: string | undefined
  try {
    let overview: Record<string, unknown>
    let importedVideo: Record<string, unknown>
    let captionCapabilityUnavailable = false
    if (input.video.currentPlan.subtitles.enabled) {
      const readiness = await waitForCaptionReadiness({
        client: input.client,
        projectId: input.projectId,
        editorUrl: input.persisted.editorUrl,
        expectedDurationSeconds: input.video.durationSeconds,
        dependencies: input.dependencies,
      })
      overview = readiness.overview
      captionCapabilityUnavailable = readiness.captionCapabilityUnavailable
      importedVideo = assertImportedVideo(overview, input.video.durationSeconds)
    } else {
      overview = await readProjectInDiscardedManualSession(input.client, input.projectId)
      importedVideo = assertImportedVideo(overview, input.video.durationSeconds)
    }

    const assets = (await listEditMediaAssets(input.video.workspace))
      .map(({ assetId, kind }) => ({ assetId, kind }))
    const generated = await generateAiEditPlan({
      instruction: input.request,
      script: input.video.script,
      currentPlan: captionCapabilityUnavailable
        ? withoutAutomaticSubtitles(input.video.currentPlan)
        : input.video.currentPlan,
      availableAssets: assets,
      videoDurationSeconds: input.video.durationSeconds,
      cacheDirectory: input.video.cacheDirectory,
    })
    if (generated.status !== 'ok') {
      throw new OpenChatCutServiceError(generated.error.code, generated.error.message)
    }
    const generatedPlan = captionCapabilityUnavailable
      ? withoutAutomaticSubtitles(generated.plan)
      : generated.plan
    if (generatedPlan.subtitles.enabled && !hasTranscriptWords(importedVideo)) {
      const readiness = await waitForCaptionReadiness({
        client: input.client,
        projectId: input.projectId,
        editorUrl: input.persisted.editorUrl,
        expectedIdentity: importedVideoIdentity(
          overview,
          input.video.durationSeconds,
        ),
        expectedDurationSeconds: input.video.durationSeconds,
        dependencies: input.dependencies,
      })
      overview = readiness.overview
      importedVideo = assertImportedVideo(overview, input.video.durationSeconds)
    }
    const expectedIdentity = importedVideoIdentity(overview, input.video.durationSeconds)
    const stable = await waitForStableEditSession({
      client: input.client,
      projectId: input.projectId,
      expectedDurationSeconds: input.video.durationSeconds,
      expectedIdentity,
      dependencies: input.dependencies,
    })
    editSessionId = stable.editSessionId
    const freshOverview = stable.overview
    const freshImportedVideo = assertImportedVideo(freshOverview, input.video.durationSeconds)
    if (generatedPlan.subtitles.enabled && !hasTranscriptWords(freshImportedVideo)) {
      throw new OpenChatCutServiceError(
        'captions_not_ready',
        'OpenChatCut 的词级转写在草案会话重开后尚未就绪，请稍后重试。',
      )
    }
    overview = freshOverview
    const target = firstVideoTarget(overview)
    if (!target) {
      throw new OpenChatCutServiceError(
        'media_not_imported',
        'OpenChatCut 时间线中还没有视频。请先导入当前视频并拖到主视频轨。',
      )
    }

    await callDraftTool(input.client, 'draft_apply', 'manage_timelines', 'manage_timelines', {
      editorProjectId: input.projectId,
      editSessionId,
      action: 'update',
      timelineId: target.timelineId,
      ratio: generatedPlan.ratio,
      fit: generatedPlan.framing.mode,
    })
    const zoom = zoomForPlan(generatedPlan)
    const editArgs = {
      editorProjectId: input.projectId,
      editSessionId,
      adds: openChatCutEffectsForPlan(generatedPlan, target.itemId, zoom),
    }
    await callDraftTool(
      input.client,
      'draft_apply',
      'edit_item_validate',
      'edit_item',
      { ...editArgs, validateOnly: true },
    )
    await callDraftTool(input.client, 'draft_apply', 'edit_item_apply', 'edit_item', editArgs)
    await callDraftTool(input.client, 'draft_apply', 'edit_captions', 'edit_captions', {
      editorProjectId: input.projectId,
      editSessionId,
      ...(generatedPlan.subtitles.enabled
        ? { action: 'enable', preset: captionPresetForPlan(generatedPlan) }
        : { action: 'disable' }),
    })
    await submitDraftForManualReview({
      client: input.client,
      projectId: input.projectId,
      editSessionId,
      summary: summaryForPlan(generatedPlan),
    })

    const next = await updatedPersistedBridge(input.client, input.persisted, {
      phase: 'needs_review',
      projectId: input.projectId,
      editSessionId,
      instructions: captionCapabilityUnavailable
        ? [
            'OpenChatCut转写服务凭据失效，本次草案不含自动字幕，可配置后重试。',
            ...instructionsFor('needs_review'),
          ]
        : instructionsFor('needs_review'),
      request: input.request,
      currentPlan: generatedPlan,
      draftToolContext: {
        stage: 'draft_apply',
        toolCode: 'get_editor_url',
      },
    })
    await saveBridge(input.video.workspace, next)
    return {
      status: 'ok',
      source: 'openchatcut',
      bridge: toPublicBridge(next, input.video.sourceVideoUrl),
    }
  } catch (error) {
    if (editSessionId) {
      let discardConfirmed = false
      try {
        const result = await callDraftTool(
          input.client,
          'draft_cleanup',
          'discard_edit_session',
          'discard_edit_session',
          {
            editorProjectId: input.projectId,
            editSessionId,
          },
        )
        discardConfirmed = isExactDiscardConfirmation(result, editSessionId)
      } catch {
        // Preserve the original apply error while keeping the session recoverable.
      }
      const failedBridge = {
        ...input.persisted,
        phase: discardConfirmed ? 'discarded' : 'drafting',
        editSessionId,
        instructions: discardConfirmed
          ? ['草案生成失败，已安全放弃未应用的编辑会话。修正问题后可以重试。']
          : ['草案生成失败，但未能确认编辑会话已放弃；请在可见编辑器中检查后重试放弃。'],
        updatedAt: new Date().toISOString(),
      } satisfies PersistedOpenChatCutBridge
      try {
        await saveBridge(input.video.workspace, failedBridge)
      } catch {
        throw new OpenChatCutServiceError(
          'bridge_persist_failed',
          discardConfirmed
            ? '草案会话结果无法保存。请在可见编辑器中检查当前会话状态。'
            : '草案会话状态无法保存。请在可见编辑器中检查并手动放弃该会话。',
          'draft_cleanup',
          'bridge_persist',
          discardConfirmed
            ? undefined
            : {
                action: 'inspect_and_discard',
                editSessionId,
          },
        )
      }
      if (!discardConfirmed) {
        const recovery = {
          action: 'inspect_and_discard' as const,
          editSessionId,
        }
        if (error instanceof OpenChatCutServiceError) {
          throw new OpenChatCutServiceError(
            error.code,
            error.message,
            error.stage,
            error.toolCode,
            error.recovery ?? recovery,
          )
        }
        const normalized = safeDraftToolError(error)
        throw new OpenChatCutServiceError(
          normalized.code,
          normalized.message,
          undefined,
          undefined,
          recovery,
        )
      }
    }
    throw error
  }
}

async function ensureOpenChatCutReady() {
  const inspected = await inspectOpenChatCutRuntime()
  if (inspected.mcpReady) return
  if (inspected.phase === 'external_instance') {
    throw new OpenChatCutServiceError(
      'external_instance',
      '检测到另一个 OpenChatCut 实例。请关闭它，再从口播智能体启动。',
    )
  }
  if (!inspected.installed) {
    throw new OpenChatCutServiceError('app_not_installed', '尚未安装 OpenChatCut，请先到设置完成安装。')
  }
  const launched = await launchOpenChatCutRuntime('app')
  if (launched.status === 'error') {
    throw new OpenChatCutServiceError(launched.error.code, launched.error.message)
  }
}

function draftMcpTransportTimeout(dependencies: OpenChatCutSessionDependencies) {
  return Math.max(
    dependencies.captionReadinessTimeoutMs ?? CAPTION_READINESS_TIMEOUT_MS,
    dependencies.projectStabilityTimeoutMs ?? PROJECT_STABILITY_TIMEOUT_MS,
  ) + DRAFT_MCP_TRANSPORT_MARGIN_MS
}

async function connectedClient(timeoutMs?: number) {
  const settings = await readOpenChatCutSettings()
  const client = new OpenChatCutMcpClient({
    bearerToken: settings.bearerToken,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  await client.connect()
  return client
}

async function resolveCurrentVideo(projectId: string): Promise<ResolvedCurrentVideo> {
  const safeProjectId = assertSafeSegment(projectId, 'projectId')
  const project = await getProjectState(safeProjectId)
  const workspace = await ensureProjectWorkspace(safeProjectId, 'digital-human')
  let source: Omit<ResolvedCurrentVideo, 'script' | 'currentPlan' | 'cacheDirectory' | 'workspace'>
  let currentPlan = createDefaultEditPlan()
  if (project.stages.edit.status === 'ready' && project.stages.edit.artifactId) {
    const artifact = await getPostProductionArtifact(workspace, project.stages.edit.artifactId)
    const scriptArtifactId = artifact.scriptArtifactId ?? project.stages.script.artifactId
    if (!scriptArtifactId) throw new ProjectStateError('script_not_ready', '当前成片没有可核对的文案 lineage。')
    currentPlan = artifact.parameters.plan
    source = {
      sourceVideoUrl: buildProjectApiEndpoint(safeProjectId, `/post-production-artifacts/${encodeURIComponent(artifact.artifactId)}/file`),
      durationSeconds: artifact.durationSeconds,
      sourceArtifactKind: 'post-production',
      sourceArtifactId: artifact.artifactId,
      baseRenderArtifactId: artifact.renderArtifactId,
      scriptArtifactId,
      sourcePath: artifact.outputPath,
    }
  } else if (project.stages.digitalHuman.status === 'ready' && project.stages.digitalHuman.artifactId) {
    const artifact = await getRenderArtifact(workspace, project.stages.digitalHuman.artifactId)
    source = {
      sourceVideoUrl: buildProjectApiEndpoint(safeProjectId, `/render-artifacts/${encodeURIComponent(artifact.artifactId)}/file`),
      durationSeconds: artifact.durationSeconds,
      sourceArtifactKind: 'render',
      sourceArtifactId: artifact.artifactId,
      baseRenderArtifactId: artifact.artifactId,
      scriptArtifactId: artifact.scriptArtifactId,
      sourcePath: artifact.outputPath,
    }
  } else {
    throw new ProjectStateError('video_not_ready', '请先生成数字人视频或本地成片。')
  }
  if (
    project.stages.script.status !== 'ready' ||
    project.stages.script.artifactId !== source.scriptArtifactId
  ) {
    throw new ProjectStateError('script_lineage_mismatch', '当前视频与已确认文案不一致，请重新生成视频。')
  }
  const scriptArtifact = await getScriptArtifact(workspace, source.scriptArtifactId)
  if (scriptArtifact.approvalStatus !== 'approved') {
    throw new ProjectStateError('script_not_approved', '文案尚未确认，不能生成专业精剪草案。')
  }
  return {
    ...source,
    script: scriptArtifact.content.body,
    currentPlan,
    cacheDirectory: resolveArtifactPath(workspace, 'post-production', '.ai-plan-cache'),
    workspace,
  }
}

async function resolveBridgeSourceVideo(projectId: string) {
  const safeProjectId = assertSafeSegment(projectId, 'projectId')
  const workspace = await ensureProjectWorkspace(safeProjectId, 'digital-human')
  const persisted = await readPersistedBridge(workspace)
  if (!persisted) throw new OpenChatCutServiceError('bridge_missing', '尚未创建 OpenChatCut 专业剪辑项目。')
  const project = await getProjectState(safeProjectId)
  if (
    project.stages.digitalHuman.status !== 'ready' ||
    project.stages.digitalHuman.artifactId !== persisted.baseRenderArtifactId ||
    project.stages.script.status !== 'ready' ||
    project.stages.script.artifactId !== persisted.scriptArtifactId
  ) {
    throw new OpenChatCutServiceError('bridge_stale', '专业剪辑记录属于旧文案或旧视频，请重新创建。')
  }
  const scriptArtifact = await getScriptArtifact(workspace, persisted.scriptArtifactId)
  if (scriptArtifact.approvalStatus !== 'approved') {
    throw new ProjectStateError('script_not_approved', '文案尚未确认，不能导出专业精剪成片。')
  }
  let sourcePath: string
  if (persisted.sourceArtifactKind === 'render') {
    const artifact = await getRenderArtifact(workspace, persisted.sourceArtifactId)
    if (
      artifact.artifactId !== persisted.baseRenderArtifactId ||
      artifact.scriptArtifactId !== persisted.scriptArtifactId
    ) {
      throw new OpenChatCutServiceError('bridge_stale', '专业剪辑源视频 lineage 已变化。')
    }
    sourcePath = artifact.outputPath
  } else {
    const artifact = await getPostProductionArtifact(workspace, persisted.sourceArtifactId)
    if (
      artifact.renderArtifactId !== persisted.baseRenderArtifactId ||
      artifact.scriptArtifactId !== persisted.scriptArtifactId
    ) {
      throw new OpenChatCutServiceError('bridge_stale', '专业剪辑源成片 lineage 已变化。')
    }
    sourcePath = artifact.outputPath
  }
  const video: ResolvedCurrentVideo = {
    sourceVideoUrl: bridgeSourceVideoUrl(persisted),
    durationSeconds: persisted.sourceDurationSeconds,
    sourceArtifactKind: persisted.sourceArtifactKind,
    sourceArtifactId: persisted.sourceArtifactId,
    baseRenderArtifactId: persisted.baseRenderArtifactId,
    scriptArtifactId: persisted.scriptArtifactId,
    script: scriptArtifact.content.body,
    currentPlan: persisted.currentPlan,
    sourcePath,
    cacheDirectory: resolveArtifactPath(workspace, 'post-production', '.ai-plan-cache'),
    workspace,
  }
  return { video, persisted }
}

async function requireCurrentBridge(video: ResolvedCurrentVideo) {
  const persisted = await readPersistedBridge(video.workspace)
  if (!persisted) throw new OpenChatCutServiceError('bridge_missing', '尚未创建 OpenChatCut 专业剪辑项目。')
  if (
    persisted.sourceArtifactKind !== video.sourceArtifactKind ||
    (persisted.sourceArtifactId !== video.sourceArtifactId &&
      persisted.exportedArtifactId !== video.sourceArtifactId) ||
    persisted.baseRenderArtifactId !== video.baseRenderArtifactId ||
    persisted.scriptArtifactId !== video.scriptArtifactId
  ) {
    throw new OpenChatCutServiceError('bridge_stale', '专业剪辑记录属于旧文案或旧视频，请重新创建。')
  }
  return persisted
}

function firstVideoTarget(value: Record<string, unknown>) {
  const timeline = recordValue(value.timeline)
  const timelineId = stringValue(timeline?.id)
  const items = Array.isArray(timeline?.items) ? timeline.items : []
  const video = items
    .filter((item): item is Record<string, unknown> => Boolean(recordValue(item)))
    .map((item) => recordValue(item)!)
    .filter((item) => item.kind === 'video')
    .sort((left, right) => numberValue(left.startFrame) - numberValue(right.startFrame))[0]
  const itemId = stringValue(video?.id)
  return timelineId && itemId ? { timelineId, itemId } : undefined
}

function videoItems(value: Record<string, unknown>) {
  const timeline = recordValue(value.timeline)
  const items = Array.isArray(timeline?.items) ? timeline.items : []
  return items
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item && item.kind === 'video'))
}

function assertImportedVideo(value: Record<string, unknown>, expectedDurationSeconds: number) {
  const videos = videoItems(value)
  if (videos.length !== 1) {
    throw new OpenChatCutServiceError(
      videos.length ? 'media_import_unverified' : 'media_not_imported',
      videos.length ? '时间线必须只有一个主视频，才能继续专业精剪。' : 'OpenChatCut 时间线中还没有视频。',
    )
  }
  const video = videos[0]
  const src = stringValue(video.src)
  if (!src || !src.startsWith('/media/uploads/') || src.startsWith('blob:')) {
    throw new OpenChatCutServiceError('media_import_unverified', '导入视频尚未落到 OpenChatCut 本地媒体库。')
  }
  const timeline = recordValue(value.timeline)
  const fps = numberValue(video.fps) || numberValue(timeline?.fps) || numberValue(value.fps)
  const durationSeconds = numberValue(video.durationSeconds) ||
    (fps > 0 ? numberValue(video.durationInFrames) / fps : 0)
  const tolerance = Math.max(2, expectedDurationSeconds * 0.2)
  if (
    durationSeconds <= 0 ||
    Math.abs(durationSeconds - expectedDurationSeconds) > tolerance
  ) {
    throw new OpenChatCutServiceError('media_duration_mismatch', 'OpenChatCut 中的视频时长与当前项目不一致。')
  }
  return video
}

async function waitForCaptionReadiness(input: {
  client: OpenChatCutMcpClient
  projectId: string
  editorUrl: string
  expectedIdentity?: ImportedVideoIdentity
  expectedDurationSeconds: number
  dependencies: OpenChatCutSessionDependencies
}): Promise<{
  overview: Record<string, unknown>
  captionCapabilityUnavailable: boolean
}> {
  const budget = createManagedWaitBudget(
    input.dependencies.captionReadinessTimeoutMs ?? CAPTION_READINESS_TIMEOUT_MS,
    input.dependencies.captionReadinessClock ?? systemManagedWaitClock,
  )
  const intervalMs = Math.max(
    1,
    input.dependencies.captionReadinessIntervalMs ?? CAPTION_READINESS_POLL_INTERVAL_MS,
  )
  let expectedIdentity = input.expectedIdentity
  let activeSessionId: string | undefined
  const supportsTranscriptionProgress = await hasStructuredTranscriptionProgress(input.client, budget)
  const cdpSettings = supportsTranscriptionProgress
    ? undefined
    : await readOpenChatCutSettings().catch(() => undefined)
  try {
    while (!budget.isExpired()) {
      const begun = await observeWithinManagedWaitBudget(
        () => input.client.callTool('begin_edit_session', {
          editorProjectId: input.projectId,
          clientName: '口播智能体转写校验',
          approvalMode: 'manual',
        }),
        budget,
      )
      if (begun.kind === 'deadline') break
      if (begun.kind === 'rejected') throw begun.reason
      activeSessionId = assertSafeSegment(
        requiredString(assertToolOk(begun.value), 'editSessionId'),
        'editSessionId',
      )

      const read = await readProjectWithStructuredStaleRecovery({
        client: input.client,
        projectId: input.projectId,
        editSessionId: activeSessionId,
        budget,
      })
      if (read.kind === 'deadline') break
      if (read.kind === 'stale' || read.kind === 'transient_timeout') {
        const discarded = await discardEditSessionWithinManagedWaitBudget(
          input.client,
          input.projectId,
          activeSessionId,
          budget,
        )
        if (!discarded) break
        activeSessionId = undefined
      } else {
        const overview = read.overview
        const importedVideo = assertImportedVideo(overview, input.expectedDurationSeconds)
        if (expectedIdentity) {
          assertImportedVideoIdentity(
            overview,
            input.expectedDurationSeconds,
            expectedIdentity,
          )
        } else {
          expectedIdentity = importedVideoIdentity(overview, input.expectedDurationSeconds)
        }
        let transcriptionState: 'auth_unavailable' | 'pending' | 'succeeded' | undefined
        if (!hasTranscriptWords(importedVideo) && supportsTranscriptionProgress) {
          transcriptionState = await readStructuredTranscriptionState({
            client: input.client,
            projectId: input.projectId,
            editSessionId: activeSessionId,
            expectedSrc: requiredString(importedVideo, 'src'),
            budget,
          })
        } else if (!hasTranscriptWords(importedVideo) && cdpSettings?.cdpPort) {
          const cdpPort = cdpSettings.cdpPort
          const inspection = await observeWithinManagedWaitBudget(
            () => inspectOpenChatCutTranscriptionStatus({
              cdpPort,
              editorUrl: input.editorUrl,
              openChatCutProjectId: input.projectId,
              expectedSrc: requiredString(importedVideo, 'src'),
            }),
            budget,
          )
          const inspected = inspection.kind === 'fulfilled'
            ? inspection.value
            : undefined
          if (inspected?.status === 'failed' && inspected.errorCode === 'auth') {
            transcriptionState = 'auth_unavailable'
          } else if (inspected?.status === 'failed') {
            throw new OpenChatCutServiceError(
              'captions_not_ready',
              'OpenChatCut 转写服务暂时不可用，本次没有生成字幕草案。',
            )
          } else if (inspected?.status === 'succeeded') {
            transcriptionState = 'succeeded'
          } else if (inspected) {
            transcriptionState = 'pending'
          }
        }
        const discarded = await discardEditSessionWithinManagedWaitBudget(
          input.client,
          input.projectId,
          activeSessionId,
          budget,
        )
        if (!discarded) break
        activeSessionId = undefined
        if (hasTranscriptWords(importedVideo)) {
          return { overview, captionCapabilityUnavailable: false }
        }
        if (transcriptionState === 'auth_unavailable') {
          return { overview, captionCapabilityUnavailable: true }
        }
      }

      const remainingMs = budget.deadline - budget.clock.now()
      if (remainingMs <= 0) break
      const slept = await sleepWithinManagedWaitBudget(Math.min(intervalMs, remainingMs), budget)
      if (slept.kind === 'deadline') break
      if (slept.kind === 'rejected') throw slept.reason
    }
    throw new OpenChatCutServiceError(
      'captions_not_ready',
      'OpenChatCut 尚未完成当前视频的词级转写，暂时不能生成字幕草案。',
    )
  } finally {
    if (activeSessionId) {
      void input.client.callTool('discard_edit_session', {
        editorProjectId: input.projectId,
        editSessionId: activeSessionId,
      }).catch(() => undefined)
    }
    budget.release()
  }
}

async function hasStructuredTranscriptionProgress(
  client: OpenChatCutMcpClient,
  budget: ManagedWaitBudget,
) {
  try {
    const observed = await observeWithinManagedWaitBudget(() => client.listTools(), budget)
    if (observed.kind !== 'fulfilled') return false
    const tools = observed.value
    const tool = tools.find((candidate) => stringValue(recordValue(candidate)?.name) === 'track_progress')
    const schema = recordValue(recordValue(tool)?.inputSchema) ??
      recordValue(recordValue(tool)?.input_schema)
    const properties = recordValue(schema?.properties)
    const target = recordValue(properties?.target)
    return Array.isArray(target?.enum) &&
      target.enum.includes('transcription') &&
      recordValue(properties?.assetIds) !== undefined
  } catch {
    return false
  }
}

async function readStructuredTranscriptionState(input: {
  client: OpenChatCutMcpClient
  projectId: string
  editSessionId: string
  expectedSrc: string
  budget: ManagedWaitBudget
}): Promise<'auth_unavailable' | 'pending' | 'succeeded'> {
  const assetsRead = await observeWithinManagedWaitBudget(
    () => input.client.callTool('read_project', {
      editorProjectId: input.projectId,
      editSessionId: input.editSessionId,
      view: 'assets',
    }),
    input.budget,
  )
  if (assetsRead.kind === 'deadline') return 'pending'
  if (assetsRead.kind === 'rejected') throw assetsRead.reason
  const assetId = importedAssetId(assertToolOk(assetsRead.value), input.expectedSrc)
  const statusRead = await observeWithinManagedWaitBudget(
    () => input.client.callTool('track_progress', {
      action: 'status',
      target: 'transcription',
      assetIds: assetId,
    }),
    input.budget,
  )
  if (statusRead.kind === 'deadline') return 'pending'
  if (statusRead.kind === 'rejected') throw statusRead.reason
  const status = assertToolOk(statusRead.value)
  const reports = status.reports
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new OpenChatCutServiceError(
      'transcription_status_invalid',
      'OpenChatCut 返回了无法核对的转写状态。',
    )
  }
  const report = recordValue(reports[0])
  if (!report || stringValue(report.assetId) !== assetId) {
    throw new OpenChatCutServiceError(
      'transcription_status_invalid',
      'OpenChatCut 转写状态与当前视频不一致。',
    )
  }
  const reportStatus = stringValue(report.status)
  if (reportStatus === 'running' || reportStatus === 'not_found') return 'pending'
  if (reportStatus === 'succeeded') return 'succeeded'
  if (reportStatus === 'failed') {
    if (isTranscriptionAuthenticationFailure(stringValue(report.error))) {
      return 'auth_unavailable'
    }
    throw new OpenChatCutServiceError(
      'captions_not_ready',
      'OpenChatCut 转写服务暂时不可用，本次没有生成字幕草案。',
    )
  }
  throw new OpenChatCutServiceError(
    'transcription_status_invalid',
    'OpenChatCut 返回了未知的转写状态。',
  )
}

function importedAssetId(value: Record<string, unknown>, expectedSrc: string) {
  const mediaPool = recordValue(value.mediaPool)
  const candidates = Array.isArray(mediaPool?.assets)
    ? mediaPool.assets
    : Array.isArray(value.assets)
      ? value.assets
      : []
  const matches = candidates
    .map(recordValue)
    .filter((candidate): candidate is Record<string, unknown> =>
      candidate !== undefined && stringValue(candidate.src) === expectedSrc)
  if (matches.length !== 1) {
    throw new OpenChatCutServiceError(
      'media_import_unverified',
      'OpenChatCut 媒体库无法唯一匹配当前视频。',
    )
  }
  return assertSafeSegment(requiredString(matches[0], 'id'), 'assetId')
}

function isTranscriptionAuthenticationFailure(error: string | undefined) {
  if (!error) return false
  return /(?:\bhttp\s*401\b|\b401\b|unauthori[sz]ed|authentication|invalid[\s_-]*(?:api[\s_-]*)?key)/i
    .test(error)
}

type ManagedProjectRead =
  | { kind: 'ready'; overview: Record<string, unknown> }
  | { kind: 'stale' }
  | { kind: 'transient_timeout' }
  | ManagedWaitDeadlineOutcome

async function readProjectWithStructuredStaleRecovery(input: {
  client: OpenChatCutMcpClient
  projectId: string
  editSessionId: string
  budget: ManagedWaitBudget
}): Promise<ManagedProjectRead> {
  const read = await observeWithinManagedWaitBudget(
    () => input.client.callTool('read_project', {
      editorProjectId: input.projectId,
      editSessionId: input.editSessionId,
      view: 'timeline',
    }),
    input.budget,
  )
  if (read.kind === 'deadline') return read

  let readFailure: unknown
  if (read.kind === 'rejected') {
    readFailure = read.reason
  } else {
    try {
      return { kind: 'ready', overview: assertToolOk(read.value) }
    } catch (error) {
      readFailure = error
    }
  }

  const status = await observeWithinManagedWaitBudget(
    () => input.client.callTool('get_edit_session', {
      editorProjectId: input.projectId,
      editSessionId: input.editSessionId,
    }),
    input.budget,
  )
  if (status.kind === 'deadline') return status
  if (status.kind === 'rejected') throw readFailure
  let session: Record<string, unknown>
  try {
    session = assertToolOk(status.value)
  } catch {
    throw readFailure
  }
  if (session.stale === true) return { kind: 'stale' }
  if (session.stale === false && isPreciseMcpReadTimeout(readFailure)) {
    return { kind: 'transient_timeout' }
  }
  throw readFailure
}

function isPreciseMcpReadTimeout(error: unknown) {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true
  return 'code' in error && error.code === 'mcp_timeout'
}

async function discardEditSessionWithinManagedWaitBudget(
  client: OpenChatCutMcpClient,
  projectId: string,
  editSessionId: string,
  budget: ManagedWaitBudget,
) {
  const discarded = await observeWithinManagedWaitBudget(
    () => client.callTool('discard_edit_session', {
      editorProjectId: projectId,
      editSessionId,
    }),
    budget,
  )
  if (discarded.kind === 'deadline') return false
  if (discarded.kind === 'rejected') {
    if (!isPreciseMcpReadTimeout(discarded.reason)) throw discarded.reason
    const status = await observeWithinManagedWaitBudget(
      () => client.callTool('get_edit_session', {
        editorProjectId: projectId,
        editSessionId,
      }),
      budget,
    )
    if (status.kind === 'deadline') return false
    if (status.kind === 'rejected') throw discarded.reason
    let session: Record<string, unknown>
    try {
      session = assertToolOk(status.value)
    } catch {
      throw discarded.reason
    }
    if (stringValue(session.status) === 'discarded') return true
    throw discarded.reason
  }
  assertToolOk(discarded.value)
  return true
}

interface ImportedVideoIdentity {
  timelineId: string
  itemId: string
  src: string
  durationSeconds: number
}

function importedVideoIdentity(
  overview: Record<string, unknown>,
  expectedDurationSeconds: number,
): ImportedVideoIdentity {
  const video = assertImportedVideo(overview, expectedDurationSeconds)
  const timeline = recordValue(overview.timeline)
  const timelineId = stringValue(timeline?.id)
  const itemId = stringValue(video.id)
  const src = stringValue(video.src)
  const fps = numberValue(video.fps) || numberValue(timeline?.fps) || numberValue(overview.fps)
  const durationSeconds = numberValue(video.durationSeconds) ||
    (fps > 0 ? numberValue(video.durationInFrames) / fps : 0)
  if (!timelineId || !itemId || !src || durationSeconds <= 0) {
    throw new OpenChatCutServiceError(
      'media_import_unverified',
      '无法确认 OpenChatCut 时间线中的当前视频身份。',
    )
  }
  return { timelineId, itemId, src, durationSeconds }
}

function assertImportedVideoIdentity(
  overview: Record<string, unknown>,
  expectedDurationSeconds: number,
  expected: ImportedVideoIdentity,
) {
  const actual = importedVideoIdentity(overview, expectedDurationSeconds)
  if (
    actual.timelineId !== expected.timelineId ||
    actual.itemId !== expected.itemId ||
    actual.src !== expected.src ||
    Math.abs(actual.durationSeconds - expected.durationSeconds) > 0.001
  ) {
    throw new OpenChatCutServiceError(
      'media_import_unverified',
      '等待转写期间 OpenChatCut 时间线中的视频已变化，请确认当前视频后重试。',
    )
  }
}

async function waitForStableEditSession(input: {
  client: OpenChatCutMcpClient
  projectId: string
  expectedDurationSeconds: number
  expectedIdentity: ImportedVideoIdentity
  dependencies: OpenChatCutSessionDependencies
}) {
  const budget = createManagedWaitBudget(
    input.dependencies.projectStabilityTimeoutMs ?? PROJECT_STABILITY_TIMEOUT_MS,
    input.dependencies.projectStabilityClock ?? systemManagedWaitClock,
  )
  const quiescenceMs = Math.max(
    1,
    input.dependencies.projectStabilityQuiescenceMs ?? PROJECT_STABILITY_QUIESCENCE_MS,
  )
  let activeSessionId: string | undefined
  try {
    stabilityLoop: while (!budget.isExpired()) {
      const begun = await observeWithinManagedWaitBudget(
        () => input.client.callTool('begin_edit_session', {
          editorProjectId: input.projectId,
          clientName: '口播智能体',
          approvalMode: 'manual',
        }),
        budget,
      )
      if (begun.kind === 'deadline') break
      if (begun.kind === 'rejected') throw begun.reason
      activeSessionId = assertSafeSegment(
        requiredString(assertToolOk(begun.value), 'editSessionId'),
        'editSessionId',
      )

      const read = await readProjectWithStructuredStaleRecovery({
        client: input.client,
        projectId: input.projectId,
        editSessionId: activeSessionId,
        budget,
      })
      if (read.kind === 'deadline') break
      if (read.kind === 'stale' || read.kind === 'transient_timeout') {
        const discarded = await discardEditSessionWithinManagedWaitBudget(
          input.client,
          input.projectId,
          activeSessionId,
          budget,
        )
        if (!discarded) break
        activeSessionId = undefined
        continue
      }
      let stale = false
      let overview = read.overview
      assertImportedVideoIdentity(
        overview,
        input.expectedDurationSeconds,
        input.expectedIdentity,
      )

      for (let confirmation = 0; confirmation < 3; confirmation += 1) {
        const quiet = await sleepWithinManagedWaitBudget(quiescenceMs, budget)
        if (quiet.kind === 'deadline') break stabilityLoop
        if (quiet.kind === 'rejected') throw quiet.reason
        const status = await observeWithinManagedWaitBudget(
          () => input.client.callTool('get_edit_session', {
            editorProjectId: input.projectId,
            editSessionId: activeSessionId,
          }),
          budget,
        )
        if (status.kind === 'deadline') break stabilityLoop
        if (status.kind === 'rejected') throw status.reason
        const session = assertToolOk(status.value)
        if (session.stale === true) {
          stale = true
          break
        }
        if (session.stale !== false) break stabilityLoop
        const confirmationRead = await readProjectWithStructuredStaleRecovery({
          client: input.client,
          projectId: input.projectId,
          editSessionId: activeSessionId,
          budget,
        })
        if (confirmationRead.kind === 'deadline') break stabilityLoop
        if (
          confirmationRead.kind === 'stale' ||
          confirmationRead.kind === 'transient_timeout'
        ) {
          stale = true
          break
        }
        overview = confirmationRead.overview
        assertImportedVideoIdentity(
          overview,
          input.expectedDurationSeconds,
          input.expectedIdentity,
        )
      }
      if (!stale) {
        const editSessionId = activeSessionId
        activeSessionId = undefined
        return { editSessionId, overview }
      }

      const discarded = await discardEditSessionWithinManagedWaitBudget(
        input.client,
        input.projectId,
        activeSessionId,
        budget,
      )
      if (!discarded) break
      activeSessionId = undefined
    }
    throw new OpenChatCutServiceError(
      'project_not_stable',
      'OpenChatCut 项目仍在更新，暂时无法建立稳定的精剪草案，请稍后重试。',
    )
  } finally {
    if (activeSessionId) {
      void input.client.callTool('discard_edit_session', {
        editorProjectId: input.projectId,
        editSessionId: activeSessionId,
      }).catch(() => undefined)
    }
    budget.release()
  }
}

function zoomForPlan(plan: EditPlanV1) {
  if (plan.creative.motion === 'dynamic') {
    return { shape: 'slow-push', magnification: plan.creative.preset === 'cinematic' ? 1.1 : 1.14 }
  }
  if (plan.creative.motion === 'punch' || plan.creative.effects.includes('punch-zoom')) {
    return { shape: 'punch', magnification: plan.creative.preset === 'energetic' ? 1.2 : 1.14 }
  }
  return {
    shape: plan.creative.preset === 'cinematic' ? 'slow-push' : 'hold',
    magnification: plan.creative.preset === 'clean' ? 1.04 : 1.08,
  }
}

function openChatCutEffectsForPlan(
  plan: EditPlanV1,
  targetItemId: string,
  zoom: ReturnType<typeof zoomForPlan>,
) {
  const effects: Array<{
    type: 'effect'
    targetItemId: string
    assetId: string
    propertyOverrides: Record<string, number | string>
  }> = [{
    type: 'effect',
    targetItemId,
    assetId: 'builtin:zoom',
    propertyOverrides: zoom,
  }]
  if (plan.creative.colorGrade === 'vivid') {
    effects.push({
      type: 'effect',
      targetItemId,
      assetId: 'builtin:look-fuji-portra',
      propertyOverrides: { intensity: 0.32 },
    })
  } else if (plan.creative.colorGrade === 'warm') {
    effects.push({
      type: 'effect',
      targetItemId,
      assetId: 'builtin:look-warm',
      propertyOverrides: { intensity: 0.3 },
    })
  }
  if (plan.creative.preset === 'energetic') {
    effects.push({
      type: 'effect',
      targetItemId,
      assetId: 'builtin:fx-clarity',
      propertyOverrides: { amount: 0.18, radius: 16 },
    })
  } else if (plan.creative.preset === 'cinematic') {
    effects.push({
      type: 'effect',
      targetItemId,
      assetId: 'builtin:fx-vignette',
      propertyOverrides: { amount: 0.24, softness: 0.65, roundness: 1 },
    }, {
      type: 'effect',
      targetItemId,
      assetId: 'builtin:fx-film-grain',
      propertyOverrides: { amount: 0.08, size: 1.2 },
    })
  }
  return effects
}

function hasTranscriptWords(video: Record<string, unknown>) {
  if (video.hasTranscript === true) return true
  const transcript = video.transcript
  if (Array.isArray(transcript)) return transcript.length > 0
  const transcriptRecord = recordValue(transcript)
  if (Array.isArray(transcriptRecord?.words)) return transcriptRecord.words.length > 0
  return Array.isArray(video.words) && video.words.length > 0
}

function withoutAutomaticSubtitles(plan: EditPlanV1): EditPlanV1 {
  return {
    ...plan,
    subtitles: {
      ...plan.subtitles,
      enabled: false,
    },
    creative: {
      ...plan.creative,
      effects: plan.creative.effects.filter((effect) => effect !== 'animated-captions'),
    },
  }
}

function captionPresetForPlan(plan: EditPlanV1) {
  if (
    plan.creative.captions === 'impact' ||
    plan.creative.effects.includes('animated-captions')
  ) return 'tiktok'
  if (plan.creative.captions === 'karaoke' || plan.subtitles.style === 'cyan') return 'bili'
  if (plan.subtitles.style === 'bold') return 'bold-outline'
  return 'netflix'
}

function summaryForPlan(plan: EditPlanV1) {
  const labels = {
    clean: '克制清晰',
    energetic: '高能节奏',
    cinematic: '电影质感',
  } as const
  return `口播智能体 AI 草案：${plan.ratio} ${plan.framing.mode === 'cover' ? '铺满画面' : '完整画面'}，${labels[plan.creative.preset]}，已为主视频添加受控镜头运动。`
}

function normalizeRequest(value: string | undefined) {
  const request = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!request) throw new OpenChatCutServiceError('request_required', '请输入精剪要求。')
  if (request.length > MAX_REQUEST_CHARS || /[\u0000-\u001f\u007f]/u.test(request)) {
    throw new OpenChatCutServiceError('request_too_long', '精剪要求不能超过 400 个字符。')
  }
  return request
}

async function updatedPersistedBridge(
  client: OpenChatCutMcpClient,
  current: PersistedOpenChatCutBridge,
  input: {
    phase: OpenChatCutProjectBridge['phase']
    projectId: string
    editSessionId: string
    instructions: string[]
    request?: string
    currentPlan?: EditPlanV1
    draftToolContext?: {
      stage: DraftToolStage
      toolCode: DraftToolCode
    }
  },
) {
  const editor = input.draftToolContext
    ? await callDraftTool(
        client,
        input.draftToolContext.stage,
        input.draftToolContext.toolCode,
        'get_editor_url',
        { projectId: input.projectId },
      )
    : assertToolOk(await client.callTool('get_editor_url', { projectId: input.projectId }))
  return {
    ...current,
    phase: input.phase,
    editorUrl: safeEditorUrl(requiredString(editor, 'editorUrl'), input.projectId),
    editSessionId: input.editSessionId,
    instructions: input.instructions,
    ...(input.request === undefined ? {} : { request: input.request }),
    ...(input.currentPlan === undefined ? {} : { currentPlan: input.currentPlan }),
    updatedAt: new Date().toISOString(),
  }
}

function instructionsFor(phase: OpenChatCutProjectBridge['phase']) {
  if (phase === 'ready_to_draft') return ['当前视频已导入并校验，可以生成 AI 精剪草案。']
  if (phase === 'needs_review') {
    return ['AI 草案已写入隔离会话。请打开剪辑台预览，并在 OpenChatCut 中批准或拒绝。']
  }
  if (phase === 'applied') {
    return ['草案已应用。请在 OpenChatCut 中检查成片，然后自动导回当前项目。']
  }
  if (phase === 'exporting') return ['正在从 OpenChatCut 导出并校验 MP4。']
  if (phase === 'exported') return ['专业精剪成片已导回当前项目。']
  if (phase === 'rejected') return ['草案已被拒绝，没有修改正式时间线。可以重新输入要求再试。']
  if (phase === 'discarded') return ['草案已放弃，没有修改正式时间线。']
  return ['专业剪辑会话正在处理中。']
}

function sessionPhase(value?: string): OpenChatCutProjectBridge['phase'] {
  if (value === 'applied') return 'applied'
  if (value === 'rejected') return 'rejected'
  if (value === 'discarded') return 'discarded'
  if (value === 'awaiting_review' || value === 'pending_review' || value === 'review') return 'needs_review'
  return 'drafting'
}

async function saveBridge(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
  bridge: PersistedOpenChatCutBridge,
) {
  await writeJsonFileAtomically(path.join(workspace.contextPath, BRIDGE_FILE_NAME), bridge)
}

async function readPersistedBridge(
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
): Promise<PersistedOpenChatCutBridge | undefined> {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(workspace.contextPath, BRIDGE_FILE_NAME), 'utf8'),
    ) as unknown
    const migrated = await migratePersistedBridge(value, workspace)
    if (!migrated) {
      throw new OpenChatCutServiceError('bridge_corrupt', 'OpenChatCut bridge 记录损坏，请重新创建。')
    }
    if ((value as { version?: unknown })?.version !== 4) await saveBridge(workspace, migrated)
    return migrated
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    if (error instanceof OpenChatCutServiceError) throw error
    throw new OpenChatCutServiceError('bridge_corrupt', 'OpenChatCut bridge 记录无法读取，请重新创建。')
  }
}

async function migratePersistedBridge(
  value: unknown,
  workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>,
): Promise<PersistedOpenChatCutBridge | undefined> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const bridge = value as Record<string, unknown>
  try {
    if (
      (bridge.version !== 1 && bridge.version !== 3 && bridge.version !== 4) ||
      typeof bridge.projectId !== 'string' ||
      typeof bridge.openChatCutProjectId !== 'string' ||
      typeof bridge.sourceArtifactId !== 'string' ||
      typeof bridge.scriptArtifactId !== 'string'
    ) return undefined
    const projectId = assertSafeSegment(bridge.projectId, 'projectId')
    const openChatCutProjectId = assertSafeSegment(bridge.openChatCutProjectId, 'openChatCutProjectId')
    const sourceArtifactId = assertSafeSegment(bridge.sourceArtifactId, 'sourceArtifactId')
    const scriptArtifactId = assertSafeSegment(bridge.scriptArtifactId, 'scriptArtifactId')
    if (
      !isBridgePhase(bridge.phase) ||
      (bridge.sourceArtifactKind !== 'render' && bridge.sourceArtifactKind !== 'post-production') ||
      typeof bridge.sourceDurationSeconds !== 'number' ||
      !Number.isFinite(bridge.sourceDurationSeconds) ||
      bridge.sourceDurationSeconds <= 0 ||
      !Array.isArray(bridge.instructions) ||
      !bridge.instructions.every((item) => typeof item === 'string') ||
      typeof bridge.updatedAt !== 'string'
    ) return undefined
    const editorUrl = safeEditorUrl(typeof bridge.editorUrl === 'string' ? bridge.editorUrl : '', openChatCutProjectId)
    const editSessionId = typeof bridge.editSessionId === 'string'
      ? assertSafeSegment(bridge.editSessionId, 'editSessionId')
      : undefined
    let exportedArtifactId = typeof bridge.exportedArtifactId === 'string'
      ? assertSafeSegment(bridge.exportedArtifactId, 'exportedArtifactId')
      : undefined
    let exportOperationId = typeof bridge.exportOperationId === 'string'
      ? assertSafeSegment(bridge.exportOperationId, 'exportOperationId')
      : undefined
    let exportSessionId = typeof bridge.exportSessionId === 'string'
      ? assertSafeSegment(bridge.exportSessionId, 'exportSessionId')
      : undefined
    let baseRenderArtifactId = typeof bridge.baseRenderArtifactId === 'string'
      ? assertSafeSegment(bridge.baseRenderArtifactId, 'baseRenderArtifactId')
      : undefined
    let request = typeof bridge.request === 'string' ? bridge.request : ''
    let currentPlan: EditPlanV1
    try {
      currentPlan = parseEditPlan(bridge.currentPlan)
    } catch {
      currentPlan = createDefaultEditPlan()
    }
    if (!baseRenderArtifactId && bridge.sourceArtifactKind === 'render') {
      baseRenderArtifactId = sourceArtifactId
    }
    if (!baseRenderArtifactId && bridge.sourceArtifactKind === 'post-production') {
      const artifact = await getPostProductionArtifact(workspace, sourceArtifactId)
      baseRenderArtifactId = artifact.renderArtifactId
      currentPlan = artifact.parameters.plan
      request = artifact.parameters.request
    }
    if (!baseRenderArtifactId) return undefined
    let phase = bridge.phase
    if (bridge.version !== 4 && (phase === 'exporting' || phase === 'exported')) {
      const project = await getProjectState(projectId)
      const stage = project.stages.edit
      const operation = stage.operation
      const expectedArtifactId = phase === 'exported' ? exportedArtifactId : stage.operation?.id
      const matches =
        stage.source === 'openchatcut' &&
        operation?.id === expectedArtifactId &&
        operation?.upstreamArtifactId === baseRenderArtifactId &&
        Boolean(operation?.sessionId)
      if (matches && operation) {
        exportOperationId = operation.id
        exportSessionId = operation.sessionId
      } else {
        phase = 'applied'
        exportOperationId = undefined
        exportSessionId = undefined
        exportedArtifactId = undefined
      }
    }
    const hasExportIdentity = Boolean(exportOperationId && exportSessionId)
    const validExportState =
      (phase === 'applied' && !hasExportIdentity && !exportedArtifactId) ||
      (phase === 'exporting' && hasExportIdentity && !exportedArtifactId) ||
      (phase === 'exported' &&
        hasExportIdentity &&
        exportedArtifactId === exportOperationId) ||
      (phase !== 'applied' && phase !== 'exporting' && phase !== 'exported' &&
        !hasExportIdentity && !exportedArtifactId)
    if (!validExportState) return undefined
    return {
      version: 4,
      projectId,
      phase,
      openChatCutProjectId,
      editorUrl,
      sourceArtifactKind: bridge.sourceArtifactKind,
      sourceArtifactId,
      baseRenderArtifactId,
      scriptArtifactId,
      sourceDurationSeconds: bridge.sourceDurationSeconds,
      request,
      currentPlan,
      instructions: bridge.instructions as string[],
      ...(editSessionId ? { editSessionId } : {}),
      ...(exportOperationId ? { exportOperationId } : {}),
      ...(exportSessionId ? { exportSessionId } : {}),
      ...(exportedArtifactId ? { exportedArtifactId } : {}),
      updatedAt: bridge.updatedAt,
    }
  } catch {
    return undefined
  }
}

function toPublicBridge(
  persisted: PersistedOpenChatCutBridge,
  sourceVideoUrl: string,
): OpenChatCutProjectBridge {
  return {
    phase: persisted.phase,
    openChatCutProjectId: persisted.openChatCutProjectId,
    editorUrl: persisted.editorUrl,
    sourceVideoUrl,
    sourceDurationSeconds: persisted.sourceDurationSeconds,
    sourceArtifactKind: persisted.sourceArtifactKind,
    sourceArtifactId: persisted.sourceArtifactId,
    scriptArtifactId: persisted.scriptArtifactId,
    instructions: persisted.instructions,
    ...(persisted.editSessionId ? { editSessionId: persisted.editSessionId } : {}),
    ...(persisted.exportedArtifactId
      ? { exportedArtifactId: persisted.exportedArtifactId, exportedVideoUrl: sourceVideoUrl }
      : {}),
  }
}

function requiredString(value: Record<string, unknown>, key: string) {
  const result = stringValue(value[key])
  if (!result) throw new OpenChatCutServiceError('invalid_response', `专业剪辑器未返回 ${key}。`)
  return result
}

function assertToolOk(value: Record<string, unknown>) {
  const error = stringValue(value.error)
  if (error) throw new OpenChatCutServiceError('tool_error', error)
  return value
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeEditorUrl(value: string, projectId: string) {
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  const expectedHash = `#/editor/${encodeURIComponent(projectId)}`
  if (
    !loopback ||
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash !== expectedHash
  ) {
    throw new OpenChatCutServiceError('invalid_editor_url', '专业剪辑器返回了无效的本机编辑地址。')
  }
  return url.toString()
}

function isBridgePhase(value: unknown): value is OpenChatCutProjectBridge['phase'] {
  return value === 'needs_user_import' ||
    value === 'ready_to_draft' ||
    value === 'drafting' ||
    value === 'needs_review' ||
    value === 'applied' ||
    value === 'exporting' ||
    value === 'exported' ||
    value === 'rejected' ||
    value === 'discarded'
}

function isMissingPathError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function normalizeServiceError(error: unknown) {
  if (error instanceof ProjectStateError || error instanceof OpenChatCutServiceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error instanceof OpenChatCutServiceError && error.stage
        ? { stage: error.stage }
        : {}),
      ...(error instanceof OpenChatCutServiceError && error.toolCode
        ? { toolCode: error.toolCode }
        : {}),
      ...(error instanceof OpenChatCutServiceError && error.recovery
        ? { recovery: error.recovery }
        : {}),
    }
  }
  return toOpenChatCutError(error)
}

function failure(code: string, message: string): OpenChatCutResult<never> {
  return { status: 'error', source: 'openchatcut', error: { code, message } }
}
