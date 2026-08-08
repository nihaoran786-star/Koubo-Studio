import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const shouldRun = process.env.RUN_OPENCHATCUT_REAL_SMOKE === '1'
const maybeIt = shouldRun ? it : it.skip
const SESSION_RECONCILE_BUSINESS_TIMEOUT_MS = 10_000
const REAL_SMOKE_TEST_TIMEOUT_MS = 300_000
const smokeRoot = path.resolve(
  process.cwd(),
  'artifacts',
  'verification',
  'openchatcut-real-smoke',
)
const defaultSourcePath = path.resolve(
  process.cwd(),
  'artifacts',
  'verification',
  'ai-edit-real-workspace',
  'artifacts',
  'render',
  'real-heygem-input.mp4',
)

type SmokePhase = 'create' | 'export'

interface SmokeEnvironment {
  phase: SmokePhase
  runId: string
  runRoot: string
  workspacesRoot: string
  projectId: string
  sourcePath: string
  appDataRoot: string
}

interface VideoProbe {
  durationSeconds: number
  codecName: string
}

interface SmokeBridge {
  phase: string
  openChatCutProjectId: string
  editSessionId?: string
  exportedArtifactId?: string
}

interface SmokeWaitClock {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

interface SmokeWaitBudget {
  clock: SmokeWaitClock
  deadline: number
  expired: Promise<{ kind: 'deadline' }>
  isExpired(): boolean
  release(): void
}

type SmokeWaitOutcome<T> =
  | { kind: 'deadline' }
  | { kind: 'fulfilled'; value: T; completedAt: number }
  | { kind: 'rejected'; reason: unknown; completedAt: number }

const systemSmokeWaitClock: SmokeWaitClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

describe('OpenChatCut real smoke preflight guards', () => {
  it('keeps the real harness timeout above the bounded session reconciliation budget', () => {
    expect(REAL_SMOKE_TEST_TIMEOUT_MS).toBeGreaterThan(
      SESSION_RECONCILE_BUSINESS_TIMEOUT_MS,
    )
  })

  it('rejects unsafe run ids without importing production modules', () => {
    expect(() => parseRunId('short')).toThrow('openchatcut_smoke_invalid_run_id')
    expect(() => parseRunId('../escape-123')).toThrow('openchatcut_smoke_invalid_run_id')
    expect(parseRunId('20260728-safe-01')).toBe('20260728-safe-01')
  })

  it('requires candidates to be strict descendants', () => {
    const root = path.resolve('artifacts', 'verification')
    expect(() => assertInside(root, root, 'unsafe')).toThrow('unsafe')
    expect(() => assertInside(root, path.dirname(root), 'unsafe')).toThrow('unsafe')
    expect(() => assertInside(root, path.join(root, 'safe'), 'unsafe')).not.toThrow()
  })

  it('times out a permanently pending export probe and observes its late rejection', async () => {
    const clock = new FakeSmokeWaitClock()
    let rejectProbe: ((reason: unknown) => void) | undefined
    const waiting = waitForExportedBridge(
      () => new Promise((_, reject) => {
        rejectProbe = reject
      }),
      'occ-fake-pending',
      fakeExportingBridge(),
      { clock, timeoutMs: 10, intervalMs: 1 },
    )

    await flushMicrotasks()
    clock.advance(1)
    await flushMicrotasks()
    clock.advance(9)
    await expect(waiting).rejects.toThrow('openchatcut_smoke_export_timeout')
    rejectProbe?.(new Error('late probe rejection'))
    await flushMicrotasks()
    expect(clock.timerCount).toBe(0)
  })

  it('clears the shared deadline and sleep timers after export succeeds', async () => {
    const clock = new FakeSmokeWaitClock()
    const waiting = waitForExportedBridge(
      async () => ({
        status: 'ok' as const,
        bridge: { ...fakeExportingBridge(), phase: 'exported', exportedArtifactId: 'post-1' },
      }),
      'occ-fake-success',
      fakeExportingBridge(),
      { clock, timeoutMs: 100, intervalMs: 5 },
    )

    await flushMicrotasks()
    clock.advance(5)
    await expect(waiting).resolves.toMatchObject({
      phase: 'exported',
      exportedArtifactId: 'post-1',
    })
    expect(clock.timerCount).toBe(0)
  })

  it('surfaces only allowlisted draft failure context and recovery identity', () => {
    expect(() => assertOpenChatCutOk({
      status: 'error' as const,
      error: {
        code: 'mcp_timeout',
        message: '专业剪辑器草案操作超时。',
        stage: 'draft_apply',
        toolCode: 'manage_timelines',
        recovery: {
          action: 'inspect_and_discard',
          editSessionId: 'edit-session-safe-1',
        },
      },
    }, 'begin')).toThrow(
      'openchatcut_smoke_begin_failed/mcp_timeout [stage=draft_apply,tool=manage_timelines,recovery=inspect_and_discard:edit-session-safe-1]: 专业剪辑器草案操作超时。',
    )
  })

  it('never surfaces untrusted draft failure context or recovery fields', () => {
    let thrown: Error | undefined
    try {
      assertOpenChatCutOk({
        status: 'error' as const,
        error: {
          code: 'mcp_timeout',
          message: '专业剪辑器草案操作超时。',
          stage: 'draft_apply token=secret',
          toolCode: 'manage_timelines params=private',
          recovery: {
            action: 'inspect_and_discard',
            editSessionId: 'unsafe/session?token=secret',
          },
        },
      }, 'begin')
    } catch (error) {
      thrown = error as Error
    }
    expect(thrown?.message).toBe(
      'openchatcut_smoke_begin_failed/mcp_timeout: 专业剪辑器草案操作超时。',
    )
    expect(thrown?.message).not.toContain('secret')
    expect(thrown?.message).not.toContain('private')
  })
})

describe('OpenChatCut real staged smoke', () => {
  maybeIt(
    'uses a real isolated workspace and stops at the supervised review boundary',
    async () => {
      // Keep every production import behind the explicit gate. In particular,
      // workspace-manager freezes KOUBO_WORKSPACES_ROOT during module loading.
      const environment = await assertSmokeEnvironment()
      if (environment.phase === 'create') {
        await runCreatePhase(environment)
      } else {
        await runExportPhase(environment)
      }
    },
    REAL_SMOKE_TEST_TIMEOUT_MS,
  )
})

async function assertSmokeEnvironment(): Promise<SmokeEnvironment> {
  const phase = parsePhase(process.env.OPENCHATCUT_REAL_SMOKE_PHASE)
  const runId = parseRunId(process.env.OPENCHATCUT_REAL_SMOKE_RUN_ID)

  const canonicalVerificationRoot = await fs.realpath(
    path.resolve(process.cwd(), 'artifacts', 'verification'),
  ).catch(() => undefined)
  if (!canonicalVerificationRoot) {
    throw new Error(
      'openchatcut_smoke_verification_root_missing: artifacts/verification 不存在。',
    )
  }
  await ensureSmokeRoot()
  const canonicalSmokeRoot = await fs.realpath(smokeRoot)
  if (
    path.dirname(canonicalSmokeRoot) !== canonicalVerificationRoot ||
    path.basename(canonicalSmokeRoot) !== 'openchatcut-real-smoke'
  ) {
    throw new Error(
      'openchatcut_smoke_unsafe_root: smoke 根目录必须是 canonical artifacts/verification 的直接子目录。',
    )
  }

  const runRoot = path.join(smokeRoot, runId)
  const workspacesRoot = path.join(runRoot, 'workspaces')
  const configuredWorkspacesRoot = process.env.KOUBO_WORKSPACES_ROOT?.trim()
  if (
    !configuredWorkspacesRoot ||
    path.resolve(configuredWorkspacesRoot) !== workspacesRoot
  ) {
    throw new Error(
      `openchatcut_smoke_workspace_root_mismatch: 启动 Vitest 前必须把 KOUBO_WORKSPACES_ROOT 设为 ${workspacesRoot}`,
    )
  }

  const requestedSource = process.env.OPENCHATCUT_REAL_SMOKE_SOURCE?.trim()
  const sourcePath = path.resolve(requestedSource || defaultSourcePath)
  assertInside(
    canonicalVerificationRoot,
    sourcePath,
    'openchatcut_smoke_unsafe_source',
  )
  const realSourcePath = await fs.realpath(sourcePath).catch(() => undefined)
  if (!realSourcePath) {
    throw new Error(`openchatcut_smoke_source_missing: 找不到真实样片 ${sourcePath}`)
  }
  assertInside(
    canonicalVerificationRoot,
    realSourcePath,
    'openchatcut_smoke_unsafe_source',
  )

  const configuredAppDataRoot = process.env.KOUBO_APP_DATA_ROOT?.trim()
  if (!configuredAppDataRoot) {
    throw new Error(
      'openchatcut_smoke_app_data_root_required: 必须显式设置 KOUBO_APP_DATA_ROOT，以读取应用当前 Provider 和 OpenChatCut runtime 配置。',
    )
  }
  const appDataRoot = await fs.realpath(path.resolve(configuredAppDataRoot)).catch(
    () => undefined,
  )
  if (!appDataRoot) {
    throw new Error(
      `openchatcut_smoke_app_data_root_missing: KOUBO_APP_DATA_ROOT 不存在：${path.resolve(configuredAppDataRoot)}`,
    )
  }
  if (
    sameOrInside(appDataRoot, workspacesRoot) ||
    sameOrInside(canonicalSmokeRoot, appDataRoot)
  ) {
    throw new Error(
      'openchatcut_smoke_app_data_root_conflict: AppData 配置根与隔离 smoke workspace 不能互相包含。',
    )
  }

  let canonicalRunRoot: string
  if (phase === 'create') {
    try {
      await fs.mkdir(runRoot)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new Error(
          `openchatcut_smoke_run_exists: ${runRoot} 已存在。为保护证据，本测试不会覆盖或删除它；请换一个 RUN_ID。`,
        )
      }
      throw error
    }
    await assertRunRootDirectory(runRoot)
    canonicalRunRoot = await fs.realpath(runRoot)
  } else {
    await assertRunRootDirectory(runRoot).catch((error) => {
      if (isNodeError(error, 'ENOENT')) {
        throw new Error(
          `openchatcut_smoke_run_missing: ${runRoot} 不存在。请先用同一个 RUN_ID 执行 create 阶段。`,
        )
      }
      throw error
    })
    canonicalRunRoot = await fs.realpath(runRoot).catch(() => undefined) ?? ''
    if (!canonicalRunRoot) {
      throw new Error(
        `openchatcut_smoke_run_missing: ${runRoot} 不存在。请先用同一个 RUN_ID 执行 create 阶段。`,
      )
    }
  }
  assertDirectChild(
    canonicalSmokeRoot,
    canonicalRunRoot,
    runId,
    'openchatcut_smoke_unsafe_run_root',
  )

  return {
    phase,
    runId,
    runRoot: canonicalRunRoot,
    workspacesRoot: path.join(canonicalRunRoot, 'workspaces'),
    projectId: `occ-${runId}`,
    sourcePath: realSourcePath,
    appDataRoot,
  }
}

async function runCreatePhase(environment: SmokeEnvironment) {
  const [
    { ensureProjectWorkspace },
    { saveScriptArtifact },
    { saveAudioArtifact },
    { saveRenderArtifact, getRenderArtifact },
    { createProjectState, mutateProjectState },
  ] = await Promise.all([
    import('@/lib/workspaces/workspace-manager'),
    import('@/lib/artifacts/script-artifact'),
    import('@/lib/artifacts/audio-artifact'),
    import('@/lib/artifacts/render-artifact'),
    import('@/lib/project-state/project-state-service'),
  ])

  const sourceProbe = await probeH264Video(environment.sourcePath)
  const workspace = await ensureProjectWorkspace(environment.projectId, 'digital-human')
  expect(path.resolve(workspace.rootPath)).toBe(
    path.join(environment.workspacesRoot, environment.projectId),
  )

  const scriptArtifactId = 'script-real-smoke'
  const audioArtifactId = 'audio-real-smoke'
  const renderArtifactId = 'render-real-smoke'
  const scriptBody =
    '这是一段用于验证 OpenChatCut 真实专业剪辑链路的数字人口播样片。请保持主体清晰，并加入克制的镜头推进。'

  await saveScriptArtifact({
    workspace,
    artifactId: scriptArtifactId,
    sessionId: 'script-real-smoke-session',
    approvalStatus: 'approved',
    content: {
      title: 'OpenChatCut 真实链路验证',
      hook: '真实剪辑链路，必须用真实成片验证。',
      body: scriptBody,
      caption: 'OpenChatCut 真实链路验证',
      tags: ['#OpenChatCut', '#数字人'],
      durationSeconds: sourceProbe.durationSeconds,
      voiceNotes: '',
      shotNotes: '保持 9:16 画幅并加入轻微推进。',
      riskNotes: '',
    },
  })
  await createProjectState({
    projectId: environment.projectId,
    script: {
      artifactId: scriptArtifactId,
      approvalStatus: 'approved',
      topic: 'OpenChatCut 真实链路验证',
      platforms: ['抖音', '小红书'],
      duration: `${Math.round(sourceProbe.durationSeconds)} 秒`,
      tone: '专业教程',
      chatStage: 'generated',
      messages: [],
      title: 'OpenChatCut 真实链路验证',
      hook: '真实剪辑链路，必须用真实成片验证。',
      body: scriptBody,
      caption: 'OpenChatCut 真实链路验证',
      tags: ['#OpenChatCut', '#数字人'],
      generated: true,
      updatedAt: new Date().toISOString(),
    },
  })

  const audioOutputPath = path.join(
    workspace.artifactsPath,
    'audio',
    `${audioArtifactId}.wav`,
  )
  await fs.mkdir(path.dirname(audioOutputPath), { recursive: true })
  await execFileAsync(
    process.env.FFMPEG_PATH?.trim() || 'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=mono:sample_rate=24000:d=${sourceProbe.durationSeconds}`,
      '-c:a',
      'pcm_s16le',
      audioOutputPath,
    ],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  await saveAudioArtifact({
    workspace,
    artifactId: audioArtifactId,
    sessionId: 'voice-real-smoke-session',
    status: 'ready',
    source: 'indextts2',
    outputPath: audioOutputPath,
    durationSeconds: sourceProbe.durationSeconds,
    parameters: {
      scriptArtifactId,
      text: scriptBody,
      speed: 1,
      emotionAlpha: 0.2,
      useRandom: false,
      outputFormat: 'wav',
    },
  })
  await mutateProjectState(environment.projectId, {
    operation: 'select_artifact',
    stage: 'voice',
    artifactId: audioArtifactId,
  })

  const renderOutputPath = path.join(
    workspace.artifactsPath,
    'render',
    `${renderArtifactId}.mp4`,
  )
  await fs.mkdir(path.dirname(renderOutputPath), { recursive: true })
  await fs.copyFile(environment.sourcePath, renderOutputPath, fs.constants.COPYFILE_EXCL)
  await saveRenderArtifact({
    workspace,
    artifactId: renderArtifactId,
    sessionId: 'digital-human-real-smoke-session',
    status: 'ready',
    source: 'heygem',
    scriptArtifactId,
    audioArtifactId,
    outputPath: renderOutputPath,
    durationSeconds: sourceProbe.durationSeconds,
    avatar: {
      source: 'upload',
      id: 'real-heygem-smoke-avatar',
      name: '真实 HeyGem 样片',
    },
    mode: 'standard',
  })
  const prepared = await mutateProjectState(environment.projectId, {
    operation: 'select_artifact',
    stage: 'digitalHuman',
    artifactId: renderArtifactId,
  })
  expect(prepared.stages.digitalHuman).toMatchObject({
    status: 'ready',
    artifactId: renderArtifactId,
  })
  const renderArtifact = await getRenderArtifact(workspace, renderArtifactId)
  expect(renderArtifact).toMatchObject({
    status: 'ready',
    source: 'heygem',
    scriptArtifactId,
    audioArtifactId,
    outputPath: renderOutputPath,
  })

  // OpenChatCut is imported only after the isolated, valid project fixture exists.
  const {
    createOpenChatCutProject,
    runOpenChatCutSession,
  } = await import('@/lib/openchatcut/integration-service')

  const created = await createOpenChatCutProject(environment.projectId)
  assertOpenChatCutOk(created, 'create')
  expect(created.bridge.phase).toBe('needs_user_import')

  const imported = await runOpenChatCutSession({
    projectId: environment.projectId,
    action: 'import',
    openChatCutProjectId: created.bridge.openChatCutProjectId,
  })
  assertOpenChatCutOk(imported, 'import')
  expect(imported.bridge.phase).toBe('ready_to_draft')

  const begun = await runOpenChatCutSession({
    projectId: environment.projectId,
    action: 'begin',
    openChatCutProjectId: imported.bridge.openChatCutProjectId,
    request: '保持 9:16 口播主体清晰，加入克制的推进动效，节奏自然。',
  })
  assertOpenChatCutOk(begun, 'begin')
  expect(begun.bridge).toMatchObject({
    phase: 'needs_review',
    openChatCutProjectId: created.bridge.openChatCutProjectId,
    sourceArtifactId: renderArtifactId,
    scriptArtifactId,
  })
  expect(begun.bridge.editSessionId).toMatch(/^[A-Za-z0-9._-]+$/)
}

async function runExportPhase(environment: SmokeEnvironment) {
  const [
    { ensureProjectWorkspace },
    { getProjectState },
    { getPostProductionArtifact },
    openChatCut,
  ] = await Promise.all([
    import('@/lib/workspaces/workspace-manager'),
    import('@/lib/project-state/project-state-service'),
    import('@/lib/artifacts/post-production-artifact'),
    import('@/lib/openchatcut/integration-service'),
  ])

  const current = await openChatCut.getOpenChatCutProject(environment.projectId)
  assertOpenChatCutOk(current, 'status')
  if (!current.bridge) {
    throw new Error(
      'openchatcut_smoke_bridge_missing: 没有找到 create 阶段留下的专业剪辑记录。',
    )
  }
  let bridge = current.bridge

  if (bridge.phase === 'needs_review' || bridge.phase === 'drafting') {
    if (!bridge.editSessionId) {
      throw new Error(
        'openchatcut_smoke_review_identity_missing: 草案缺少 editSessionId，无法核对人工审核状态。',
      )
    }
    const refreshed = await openChatCut.runOpenChatCutSession({
      projectId: environment.projectId,
      action: 'status',
      openChatCutProjectId: bridge.openChatCutProjectId,
      editSessionId: bridge.editSessionId,
    }, {
      sessionReconcileTimeoutMs: SESSION_RECONCILE_BUSINESS_TIMEOUT_MS,
    })
    assertOpenChatCutOk(refreshed, 'status')
    bridge = refreshed.bridge
  }

  if (bridge.phase === 'needs_review' || bridge.phase === 'drafting') {
    throw new Error(
      'openchatcut_smoke_waiting_for_manual_review: 草案仍在等待人工审核。请在可见 OpenChatCut 中预览并批准，然后重新执行 export 阶段。',
    )
  }
  if (bridge.phase === 'rejected' || bridge.phase === 'discarded') {
    throw new Error(
      `openchatcut_smoke_review_not_applied: 当前草案状态为 ${bridge.phase}，请重新执行新的 create 阶段并人工批准。`,
    )
  }

  if (bridge.phase !== 'exported') {
    if (bridge.phase === 'exporting') {
      bridge = await waitForExportedBridge(
        openChatCut.getOpenChatCutProject,
        environment.projectId,
        bridge,
      )
    } else if (bridge.phase !== 'applied') {
      throw new Error(
        `openchatcut_smoke_export_not_ready: 当前阶段为 ${bridge.phase}，不能导出。`,
      )
    } else {
      const exported = await openChatCut.runOpenChatCutSession({
        projectId: environment.projectId,
        action: 'export',
        openChatCutProjectId: bridge.openChatCutProjectId,
        editSessionId: bridge.editSessionId,
      })
      assertOpenChatCutOk(exported, 'export')
      bridge = exported.bridge
      if (bridge.phase === 'exporting') {
        bridge = await waitForExportedBridge(
          openChatCut.getOpenChatCutProject,
          environment.projectId,
          bridge,
        )
      }
    }
  }

  expect(bridge.phase).toBe('exported')
  expect(bridge.exportedArtifactId).toBeTruthy()
  const exportedArtifactId = bridge.exportedArtifactId!
  const project = await getProjectState(environment.projectId)
  expect(project.stages.edit).toMatchObject({
    status: 'ready',
    source: 'openchatcut',
    artifactId: exportedArtifactId,
  })

  const workspace = await ensureProjectWorkspace(environment.projectId, 'digital-human')
  const artifact = await getPostProductionArtifact(workspace, exportedArtifactId)
  expect(artifact).toMatchObject({
    status: 'ready',
    source: 'openchatcut',
    artifactId: exportedArtifactId,
    renderArtifactId: 'render-real-smoke',
    scriptArtifactId: 'script-real-smoke',
  })
  const stat = await fs.stat(artifact.outputPath)
  expect(stat.isFile()).toBe(true)
  expect(stat.size).toBeGreaterThan(0)
  const probe = await probeH264Video(artifact.outputPath)
  expect(probe.codecName).toBe('h264')
  expect(probe.durationSeconds).toBeGreaterThan(0)
}

async function waitForExportedBridge<TBridge extends SmokeBridge>(
  getProject: (projectId: string) => Promise<{
    status: 'ok' | 'error'
    bridge?: TBridge
    stale?: boolean
    detail?: string
    error?: { code: string; message: string }
  }>,
  projectId: string,
  initial: TBridge,
  options: {
    clock?: SmokeWaitClock
    timeoutMs?: number
    intervalMs?: number
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 180_000
  const intervalMs = options.intervalMs ?? 750
  const budget = createSmokeWaitBudget(
    timeoutMs,
    options.clock ?? systemSmokeWaitClock,
  )
  let bridge = initial
  try {
    while (bridge.phase === 'exporting' && !budget.isExpired()) {
      const remainingMs = budget.deadline - budget.clock.now()
      if (remainingMs <= 0) throw exportTimeout(timeoutMs)
      const slept = await sleepWithinSmokeWaitBudget(
        Math.min(intervalMs, remainingMs),
        budget,
      )
      if (slept.kind === 'deadline') throw exportTimeout(timeoutMs)
      if (slept.kind === 'rejected') throw slept.reason

      const observed = await observeWithinSmokeWaitBudget(
        () => getProject(projectId),
        budget,
      )
      if (observed.kind === 'deadline') throw exportTimeout(timeoutMs)
      if (observed.kind === 'rejected') throw observed.reason
      const current = observed.value
      assertOpenChatCutOk(current, 'export')
      if (current.stale) {
        throw new Error(
          `openchatcut_smoke_export_terminal/stale: ${current.detail ?? '导出记录已失效。'}`,
        )
      }
      if (!current.bridge) {
        throw new Error(
          'openchatcut_smoke_export_terminal/bridge_missing: 导出期间 bridge 消失。',
        )
      }
      bridge = current.bridge
    }
    if (bridge.phase === 'exported') return bridge
    if (bridge.phase === 'exporting') throw exportTimeout(timeoutMs)
    throw new Error(
      `openchatcut_smoke_export_terminal/${bridge.phase}: 导出没有完成，已停止在 ${bridge.phase}。`,
    )
  } finally {
    budget.release()
  }
}

function createSmokeWaitBudget(
  timeoutMs: number,
  clock: SmokeWaitClock,
): SmokeWaitBudget {
  const boundedTimeoutMs = Math.max(0, timeoutMs)
  const deadline = clock.now() + boundedTimeoutMs
  let expired = false
  let released = false
  let deadlineHandle: unknown
  const expiredPromise = new Promise<{ kind: 'deadline' }>((resolve) => {
    deadlineHandle = clock.setTimeout(() => {
      expired = true
      resolve({ kind: 'deadline' })
    }, boundedTimeoutMs)
  })
  return {
    clock,
    deadline,
    expired: expiredPromise,
    isExpired: () => expired || clock.now() >= deadline,
    release: () => {
      if (released) return
      released = true
      clock.clearTimeout(deadlineHandle)
    },
  }
}

async function observeWithinSmokeWaitBudget<T>(
  operation: () => T | PromiseLike<T>,
  budget: SmokeWaitBudget,
): Promise<SmokeWaitOutcome<T>> {
  if (budget.isExpired()) return { kind: 'deadline' }
  // Attach both handlers before racing the shared deadline so a late rejection
  // remains observed after the caller has already timed out.
  const observed = observeSmokeWaitOperation(operation, budget.clock)
  const outcome = await Promise.race([observed, budget.expired])
  if (outcome.kind !== 'deadline' && outcome.completedAt > budget.deadline) {
    return { kind: 'deadline' }
  }
  return outcome
}

function observeSmokeWaitOperation<T>(
  operation: () => T | PromiseLike<T>,
  clock: SmokeWaitClock,
): Promise<SmokeWaitOutcome<T>> {
  try {
    return Promise.resolve(operation()).then(
      (value) => ({ kind: 'fulfilled', value, completedAt: clock.now() }),
      (reason) => ({ kind: 'rejected', reason, completedAt: clock.now() }),
    )
  } catch (reason) {
    return Promise.resolve({ kind: 'rejected', reason, completedAt: clock.now() })
  }
}

async function sleepWithinSmokeWaitBudget(
  milliseconds: number,
  budget: SmokeWaitBudget,
): Promise<SmokeWaitOutcome<void>> {
  let sleepHandle: unknown
  try {
    return await observeWithinSmokeWaitBudget(
      () => new Promise<void>((resolve) => {
        sleepHandle = budget.clock.setTimeout(resolve, milliseconds)
      }),
      budget,
    )
  } finally {
    if (sleepHandle !== undefined) budget.clock.clearTimeout(sleepHandle)
  }
}

function exportTimeout(timeoutMs: number) {
  return new Error(
    `openchatcut_smoke_export_timeout: ${timeoutMs / 1000} 秒内没有得到 exported 成片状态。`,
  )
}

function assertOpenChatCutOk<T extends {
  status: 'ok' | 'error'
  error?: {
    code: string
    message: string
    stage?: unknown
    toolCode?: unknown
    recovery?: unknown
  }
}>(
  result: T,
  stage: 'create' | 'import' | 'begin' | 'status' | 'export',
): asserts result is T & { status: 'ok' } {
  if (result.status === 'ok') return
  const code = result.error?.code ?? 'unknown_error'
  const message = result.error?.message ?? '未知错误'
  const context = safeSmokeFailureContext(result.error)
  if (code === 'external_instance') {
    throw new Error(
      `openchatcut_smoke_external_instance: ${message} 请保存并关闭外部实例后，只从口播智能体启动受管实例；本测试不会替你关闭窗口。`,
    )
  }
  if (
    code.startsWith('ai_provider_') ||
    code === 'ai_model_auth_error' ||
    code === 'ai_model_model_error'
  ) {
    throw new Error(
      `openchatcut_smoke_provider_not_configured: ${message} 请在口播智能体设置页配置并测试默认 AI Provider。`,
    )
  }
  if (stage === 'export') {
    throw new Error(`openchatcut_smoke_export_failed/${code}${context}: ${message}`)
  }
  throw new Error(`openchatcut_smoke_${stage}_failed/${code}${context}: ${message}`)
}

const SAFE_SMOKE_FAILURE_STAGES = new Set([
  'draft_prepare',
  'draft_apply',
  'draft_cleanup',
  'session_discard',
  'session_reconcile',
])

const SAFE_SMOKE_FAILURE_TOOLS = new Set([
  'target_project',
  'manage_timelines',
  'edit_item_validate',
  'edit_item_apply',
  'edit_captions',
  'review_edit_session',
  'get_editor_url',
  'get_edit_session',
  'discard_edit_session',
  'bridge_persist',
])

function safeSmokeFailureContext(error: {
  stage?: unknown
  toolCode?: unknown
  recovery?: unknown
} | undefined) {
  if (!error) return ''
  const fields: string[] = []
  if (
    typeof error.stage === 'string' &&
    SAFE_SMOKE_FAILURE_STAGES.has(error.stage)
  ) fields.push(`stage=${error.stage}`)
  if (
    typeof error.toolCode === 'string' &&
    SAFE_SMOKE_FAILURE_TOOLS.has(error.toolCode)
  ) fields.push(`tool=${error.toolCode}`)
  if (
    error.recovery &&
    typeof error.recovery === 'object' &&
    !Array.isArray(error.recovery)
  ) {
    const recovery = error.recovery as Record<string, unknown>
    if (
      recovery.action === 'inspect_and_discard' &&
      typeof recovery.editSessionId === 'string' &&
      /^[A-Za-z0-9._~-]+$/.test(recovery.editSessionId)
    ) {
      fields.push(`recovery=inspect_and_discard:${recovery.editSessionId}`)
    }
  }
  return fields.length ? ` [${fields.join(',')}]` : ''
}

async function probeH264Video(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(
    process.env.FFPROBE_PATH?.trim() || 'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name:format=duration',
      '-of',
      'json',
      filePath,
    ],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string }>
    format?: { duration?: string }
  }
  const codecName = parsed.streams?.[0]?.codec_name
  const durationSeconds = Number(parsed.format?.duration)
  if (codecName !== 'h264' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `openchatcut_smoke_invalid_video: ${filePath} 必须是 ffprobe 可读、时长为正且包含 H.264 视频流的 MP4。`,
    )
  }
  return { codecName, durationSeconds }
}

function assertInside(root: string, candidate: string, code: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${code}: 路径必须严格位于 ${root} 内。`)
  }
}

function assertDirectChild(
  root: string,
  candidate: string,
  expectedName: string,
  code: string,
) {
  if (
    path.dirname(candidate) !== root ||
    path.basename(candidate) !== expectedName
  ) {
    throw new Error(`${code}: runRoot 必须是 canonical smokeRoot 的直接子目录。`)
  }
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function sameOrInside(root: string, candidate: string) {
  return path.resolve(root) === path.resolve(candidate) || isInside(root, candidate)
}

function parsePhase(value: string | undefined): SmokePhase {
  const phase = value?.trim()
  if (phase !== 'create' && phase !== 'export') {
    throw new Error(
      'openchatcut_smoke_invalid_phase: OPENCHATCUT_REAL_SMOKE_PHASE 必须是 create 或 export。',
    )
  }
  return phase
}

function parseRunId(value: string | undefined) {
  const runId = value?.trim() ?? ''
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(runId)) {
    throw new Error(
      'openchatcut_smoke_invalid_run_id: RUN_ID 只能包含小写字母、数字和连字符，长度为 8–64。',
    )
  }
  return runId
}

async function ensureSmokeRoot() {
  try {
    await fs.mkdir(smokeRoot)
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return
    throw error
  }
}

async function assertRunRootDirectory(runRoot: string) {
  const stat = await fs.lstat(runRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      'openchatcut_smoke_unsafe_run_root: runRoot 必须是应用原子创建的真实目录，不能是文件或 reparse link。',
    )
  }
}

function fakeExportingBridge(): SmokeBridge {
  return {
    phase: 'exporting',
    openChatCutProjectId: 'occ-project-fake',
    editSessionId: 'edit-session-fake',
  }
}

class FakeSmokeWaitClock implements SmokeWaitClock {
  nowValue = 0
  nextId = 1
  timers = new Map<number, { dueAt: number; callback: () => void }>()

  get timerCount() {
    return this.timers.size
  }

  now() {
    return this.nowValue
  }

  setTimeout(callback: () => void, milliseconds: number) {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, {
      dueAt: this.nowValue + Math.max(0, milliseconds),
      callback,
    })
    return id
  }

  clearTimeout(handle: unknown) {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  advance(milliseconds: number) {
    const target = this.nowValue + milliseconds
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0]
      if (!next) break
      const [id, timer] = next
      this.timers.delete(id)
      this.nowValue = timer.dueAt
      timer.callback()
    }
    this.nowValue = target
  }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
