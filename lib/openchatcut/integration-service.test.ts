import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultEditPlan } from '@/lib/post-production/edit-plan'

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  getDurableEditSessionStatus: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  projectState: {
    projectId: 'demo',
    title: '测试项目',
    stages: {
      script: { status: 'ready', artifactId: 'script-1' },
      edit: { status: 'idle' },
      digitalHuman: { status: 'ready', artifactId: 'render-1' },
    },
  } as any,
  workspace: undefined as any,
  generatePlan: vi.fn(),
  openEditor: vi.fn(),
  importSource: vi.fn(),
  exportVideo: vi.fn(),
  probeExport: vi.fn(),
  inspectTranscription: vi.fn(),
  beginStage: vi.fn(),
  markStageRunning: vi.fn(),
  completeStage: vi.fn(),
  failStage: vi.fn(),
  reconcileStage: vi.fn(),
  savePostArtifact: vi.fn(),
  getPostArtifact: vi.fn(),
}))

vi.mock('@/lib/project-state/project-state-service', () => ({
  ProjectStateError: class ProjectStateError extends Error {
    constructor(public code: string, message: string) { super(message) }
  },
  getProjectState: vi.fn(async () => mocks.projectState),
  beginProjectStageOperation: (...args: unknown[]) => mocks.beginStage(...args),
  markProjectStageOperationRunning: (...args: unknown[]) => mocks.markStageRunning(...args),
  completeProjectStageOperation: (...args: unknown[]) => mocks.completeStage(...args),
  failProjectStageOperation: (...args: unknown[]) => mocks.failStage(...args),
  reconcileProjectStageOperation: (...args: unknown[]) => mocks.reconcileStage(...args),
}))
vi.mock('@/lib/workspaces/workspace-manager', () => ({
  ensureProjectWorkspace: vi.fn(async () => mocks.workspace),
}))
vi.mock('@/lib/artifacts/render-artifact', () => ({
  getRenderArtifact: vi.fn(async () => ({
    artifactId: mocks.projectState.stages.digitalHuman.artifactId,
    scriptArtifactId: 'script-1',
    durationSeconds: 12,
    outputPath: path.join(mocks.workspace.rootPath, 'artifacts', 'render', 'render-1.mp4'),
  })),
}))
vi.mock('@/lib/artifacts/post-production-artifact', () => ({
  getPostProductionArtifact: (...args: unknown[]) => mocks.getPostArtifact(...args),
  savePostProductionArtifact: (...args: unknown[]) => mocks.savePostArtifact(...args),
}))
vi.mock('@/lib/artifacts/script-artifact', () => ({
  getScriptArtifact: vi.fn(async () => ({
    artifactId: 'script-1',
    approvalStatus: 'approved',
    content: { body: '这是一段已经确认的测试口播文案。' },
  })),
}))
vi.mock('@/lib/post-production/edit-media-asset', () => ({
  listEditMediaAssets: vi.fn(async () => []),
}))
vi.mock('@/lib/post-production/edit-plan-agent', () => ({
  generateAiEditPlan: (...args: unknown[]) => mocks.generatePlan(...args),
}))
vi.mock('@/lib/artifacts/artifact-manager', () => ({
  resolveArtifactPath: (workspace: { artifactsPath: string }, type: string, name: string) =>
    path.join(workspace.artifactsPath, type, name),
}))
vi.mock('./runtime-adapter', () => ({
  inspectOpenChatCutRuntime: vi.fn(async () => ({
    phase: 'mcp_ready',
    installed: true,
    installerReady: false,
    mcpReady: true,
    detail: 'ready',
    version: '0.1.6',
  })),
  launchOpenChatCut: vi.fn(async () => ({ status: 'ok', source: 'openchatcut' })),
  downloadOpenChatCutInstaller: vi.fn(),
}))
vi.mock('./settings-store', () => ({
  readOpenChatCutSettings: vi.fn(async () => ({ version: 2, cdpPort: 43210 })),
}))
vi.mock('./electron-cdp-adapter', () => ({
  openOpenChatCutProjectEditor: (...args: unknown[]) => mocks.openEditor(...args),
  importOpenChatCutSource: (...args: unknown[]) => mocks.importSource(...args),
  exportOpenChatCutVideo: (...args: unknown[]) => mocks.exportVideo(...args),
  probeOpenChatCutExport: (...args: unknown[]) => mocks.probeExport(...args),
  inspectOpenChatCutTranscriptionStatus: (...args: unknown[]) =>
    mocks.inspectTranscription(...args),
}))
vi.mock('./mcp-client', () => ({
  OpenChatCutMcpClient: class {
    constructor(options: Record<string, unknown>) {
      mocks.clientOptions.push(options)
    }
    connect = mocks.connect
    listTools = mocks.listTools
    callTool = async (
      name: string,
      args: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ) => {
      const result = options === undefined
        ? await mocks.callTool(name, args)
        : await mocks.callTool(name, args, options)
      if (
        name === 'get_edit_session' &&
        result &&
        typeof result === 'object' &&
        result.ok === true &&
        !('stale' in result)
      ) {
        return { ...result, stale: false }
      }
      return result
    }
    getDurableEditSessionStatus = mocks.getDurableEditSessionStatus
  },
  toOpenChatCutError: (error: unknown) => ({
    code: error instanceof Error &&
      error.name === 'OpenChatCutMcpError' &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
  }),
}))

import {
  createOpenChatCutProject,
  getOpenChatCutProject,
  launchOpenChatCutRuntime,
  runOpenChatCutSession as runOpenChatCutSessionImpl,
  waitForOpenChatCutMcp,
  type ManagedWaitClock,
} from './integration-service'

const runOpenChatCutSession = (
  input: Parameters<typeof runOpenChatCutSessionImpl>[0],
  dependencies: Parameters<typeof runOpenChatCutSessionImpl>[1] = {},
) => runOpenChatCutSessionImpl(input, {
  projectStabilityQuiescenceMs: 1,
  ...dependencies,
})

async function realNormalizedMcpTimeoutError() {
  const actual = await vi.importActual<typeof import('./mcp-client')>('./mcp-client')
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
    if (request.method === 'initialize') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { protocolVersion: '2025-03-26' },
      }), { headers: { 'mcp-session-id': 'real-normalized-timeout-session' } })
    }
    if (request.method === 'notifications/initialized') return new Response('', { status: 202 })
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })
  const client = new actual.OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })
  await client.connect()
  try {
    await client.callTool('read_project')
  } catch (error) {
    return error
  }
  throw new Error('expected the real MCP client to normalize the timeout')
}

class VirtualManagedWaitClock implements ManagedWaitClock {
  private currentTime = 0
  private nextTimerId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  readonly scheduledDelays: number[] = []

  now() {
    return this.currentTime
  }

  setTimeout(callback: () => void, milliseconds: number) {
    const timerId = this.nextTimerId
    this.nextTimerId += 1
    const delay = Math.max(0, milliseconds)
    this.scheduledDelays.push(delay)
    this.timers.set(timerId, { at: this.currentTime + delay, callback })
    return timerId
  }

  clearTimeout(handle: unknown) {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  jump(milliseconds: number) {
    this.currentTime += milliseconds
  }

  async flush() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  }

  async advance(milliseconds: number) {
    const target = this.currentTime + milliseconds
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [timerId, timer] = next
      this.currentTime = timer.at
      this.timers.delete(timerId)
      timer.callback()
      await this.flush()
    }
    this.currentTime = Math.max(this.currentTime, target)
    await this.flush()
  }

  get timerCount() {
    return this.timers.size
  }
}

describe('OpenChatCut integration service', () => {
  let root = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchatcut-service-'))
    mocks.workspace = {
      workspaceId: 'demo',
      projectId: 'demo',
      featureType: 'digital-human',
      rootPath: root,
      filesPath: path.join(root, 'files'),
      contextPath: path.join(root, 'context'),
      outputsPath: path.join(root, 'outputs'),
      artifactsPath: path.join(root, 'artifacts'),
      sessionsRootPath: path.join(root, 'sessions'),
      featureSessionPath: path.join(root, 'sessions', 'digital-human'),
      agentSessionsPath: path.join(root, 'sessions', 'agents'),
    }
    await fs.mkdir(mocks.workspace.contextPath, { recursive: true })
    mocks.projectState.stages.digitalHuman.artifactId = 'render-1'
    mocks.projectState.stages.edit = { status: 'idle' }
    mocks.callTool.mockReset()
    mocks.getDurableEditSessionStatus.mockReset()
    mocks.connect.mockReset()
    mocks.listTools.mockReset()
    mocks.clientOptions.length = 0
    mocks.generatePlan.mockReset()
    mocks.openEditor.mockReset()
    mocks.importSource.mockReset()
    mocks.exportVideo.mockReset()
    mocks.probeExport.mockReset()
    mocks.inspectTranscription.mockReset()
    mocks.beginStage.mockReset()
    mocks.markStageRunning.mockReset()
    mocks.completeStage.mockReset()
    mocks.failStage.mockReset()
    mocks.reconcileStage.mockReset()
    mocks.savePostArtifact.mockReset()
    mocks.getPostArtifact.mockReset()
    mocks.importSource.mockResolvedValue({ status: 'ok' })
    mocks.listTools.mockResolvedValue([])
    mocks.getDurableEditSessionStatus.mockResolvedValue(undefined)
    mocks.inspectTranscription.mockRejectedValue(new Error('adapter unavailable'))
    mocks.openEditor.mockResolvedValue({ status: 'ok' })
    mocks.exportVideo.mockResolvedValue({
      status: 'ok',
      outputPath: path.join(root, 'artifacts', 'post-production', 'export.mp4'),
      durationSeconds: 12,
    })
    mocks.probeExport.mockResolvedValue({ codec: 'h264', durationSeconds: 12 })
    mocks.beginStage.mockImplementation(async (input: any) => {
      mocks.projectState.stages.edit = {
        status: 'queued',
        source: 'openchatcut',
        operation: {
          id: input.operationId,
          sessionId: input.sessionId,
          upstreamArtifactId: input.expectedUpstreamArtifactId,
          startedAt: new Date().toISOString(),
        },
      }
      return {}
    })
    mocks.markStageRunning.mockImplementation(async () => {
      mocks.projectState.stages.edit = { ...mocks.projectState.stages.edit, status: 'running' }
      return {}
    })
    mocks.completeStage.mockImplementation(async (input: any) => {
      mocks.projectState.stages.edit = {
        ...mocks.projectState.stages.edit,
        status: 'ready',
        artifactId: input.artifactId,
      }
      return {}
    })
    mocks.failStage.mockImplementation(async (input: any) => {
      mocks.projectState.stages.edit = {
        ...mocks.projectState.stages.edit,
        status: 'failed',
        error: input.error,
      }
      return {}
    })
    mocks.reconcileStage.mockImplementation(async (input: any) => {
      if (input.task.status === 'ready') {
        mocks.projectState.stages.edit = {
          ...mocks.projectState.stages.edit,
          status: 'ready',
          artifactId: input.task.artifactId,
        }
      }
      return mocks.projectState
    })
    mocks.savePostArtifact.mockResolvedValue({})
    mocks.getPostArtifact.mockImplementation(async (_workspace: unknown, artifactId: string) => ({
      artifactId,
      status: 'ready',
      source: 'openchatcut',
      sessionId: mocks.projectState.stages.edit.operation?.sessionId ?? 'openchatcut-export-test',
      renderArtifactId: 'render-1',
      scriptArtifactId: 'script-1',
      durationSeconds: 12,
      outputPath: path.join(root, 'artifacts', 'post-production', `${artifactId}.mp4`),
      parameters: { plan: createDefaultEditPlan(), request: '专业精剪' },
    }))
    mocks.generatePlan.mockResolvedValue({
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan: {
        ...createDefaultEditPlan(),
        creative: {
          ...createDefaultEditPlan().creative,
          preset: 'energetic',
          motion: 'punch',
          captions: 'impact',
          colorGrade: 'vivid',
          effects: ['animated-captions', 'punch-zoom'],
        },
      },
    })
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'create_project') return { id: 'occ-project-1' }
      if (name === 'get_editor_url') return {
        editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
      }
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') return {
        timeline: {
          id: 'timeline-1',
          fps: 30,
          items: [{
            id: 'video-1',
            kind: 'video',
            src: '/media/uploads/current.mp4',
            startFrame: 0,
            durationInFrames: 360,
            transcript: [
              { text: '你好', start: 0, end: 500 },
              { text: '世界', start: 520, end: 1_000 },
            ],
          }],
        },
      }
      if (name === 'get_edit_session') return { status: 'awaiting_review', stale: false }
      return { ok: true }
    })
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  async function createBridge() {
    const result = await createOpenChatCutProject('demo')
    expect(result.status).toBe('ok')
    return result
  }

  async function readBridgeFile() {
    return JSON.parse(
      await fs.readFile(path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'), 'utf8'),
    ) as Record<string, any>
  }

  async function writeExportingBridge(
    operationId = 'openchatcut-recovery-1',
    sessionId = 'openchatcut-export-recovery-1',
    sourceDurationSeconds = 12,
  ) {
    const current = await readBridgeFile()
    const next = {
      ...current,
      version: 4,
      phase: 'exporting',
      exportOperationId: operationId,
      exportSessionId: sessionId,
      sourceDurationSeconds,
      instructions: ['正在导出'],
      updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
      `${JSON.stringify(next, null, 2)}\n`,
    )
    return next
  }

  async function writeSessionBridge(
    phase: 'drafting' | 'needs_review' = 'needs_review',
    editSessionId = 'edit-session-1',
  ) {
    const current = await readBridgeFile()
    const next = {
      ...current,
      phase,
      editSessionId,
      instructions: ['等待用户处理草案'],
      updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
      `${JSON.stringify(next, null, 2)}\n`,
    )
    return next
  }

  it('reconciles a local drafting bridge only from the exact remote discarded session', async () => {
    await createBridge()
    await writeSessionBridge('drafting')
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') {
        return { projectId: 'occ-project-1' }
      }
      if (name === 'get_edit_session') {
        return { editSessionId: 'edit-session-1', status: 'discarded' }
      }
      throw new Error(`unexpected tool: ${name}`)
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'discarded',
        editSessionId: 'edit-session-1',
      },
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      'target_project',
      'get_edit_session',
    ])
    await expect(readBridgeFile()).resolves.toMatchObject({
      phase: 'discarded',
      editSessionId: 'edit-session-1',
    })
  })

  it.each([
    ['wrong target id', { projectId: 'other-project' }, undefined],
    ['missing target id', {}, undefined],
    ['blank target id', { projectId: ' ' }, undefined],
    ['wrong session id', { projectId: 'occ-project-1' }, {
      editSessionId: 'other-session',
      status: 'discarded',
    }],
    ['missing session id', { projectId: 'occ-project-1' }, { status: 'discarded' }],
    ['blank session id', { projectId: 'occ-project-1' }, {
      editSessionId: ' ',
      status: 'discarded',
    }],
    ['applied status', { projectId: 'occ-project-1' }, {
      editSessionId: 'edit-session-1',
      status: 'applied',
    }],
    ['blank status', { projectId: 'occ-project-1' }, {
      editSessionId: 'edit-session-1',
      status: ' ',
    }],
    ['whitespace status', { projectId: 'occ-project-1' }, {
      editSessionId: 'edit-session-1',
      status: ' discarded ',
    }],
  ])('fails closed while reconciling drafting for %s', async (
    _label,
    targetResult,
    sessionResult,
  ) => {
    await createBridge()
    await writeSessionBridge('drafting')
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const originalBytes = await fs.readFile(bridgePath)
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return targetResult
      if (name === 'get_edit_session') return sessionResult
      throw new Error(`unexpected tool: ${name}`)
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })

    expect(result).toEqual({
      status: 'error',
      source: 'openchatcut',
      error: {
        code: 'session_reconcile_unconfirmed',
        message: '未能确认远端草案会话已安全放弃。请在可见编辑器中检查当前会话状态。',
        stage: 'session_reconcile',
        toolCode: 'get_edit_session',
      },
    })
    expect((await fs.readFile(bridgePath)).equals(originalBytes)).toBe(true)
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('discard_edit_session')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('get_editor_url')
  })

  it('bounds drafting reconciliation, ignores a late success and preserves bridge bytes', async () => {
    await createBridge()
    await writeSessionBridge('drafting')
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const originalBytes = await fs.readFile(bridgePath)
    const clock = new VirtualManagedWaitClock()
    let resolveSession!: (value: Record<string, unknown>) => void
    let markSessionStarted!: () => void
    const sessionStarted = new Promise<void>((resolve) => {
      markSessionStarted = resolve
    })
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { projectId: 'occ-project-1' }
      if (name === 'get_edit_session') {
        markSessionStarted()
        return await new Promise<Record<string, unknown>>((resolve) => {
          resolveSession = resolve
        })
      }
      throw new Error(`unexpected tool: ${name}`)
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    }, {
      sessionReconcileClock: clock,
      sessionReconcileTimeoutMs: 10,
    })
    await sessionStarted
    await clock.advance(10)
    await expect(pending).resolves.toEqual({
      status: 'error',
      source: 'openchatcut',
      error: {
        code: 'session_reconcile_unconfirmed',
        message: '未能确认远端草案会话已安全放弃。请在可见编辑器中检查当前会话状态。',
        stage: 'session_reconcile',
        toolCode: 'get_edit_session',
      },
    })
    resolveSession({
      editSessionId: 'edit-session-1',
      status: 'discarded',
    })
    await clock.flush()

    expect((await fs.readFile(bridgePath)).equals(originalBytes)).toBe(true)
    expect(clock.timerCount).toBe(0)
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      'target_project',
      'get_edit_session',
    ])
  })

  it('reports a fixed persistence error when exact reconciliation cannot atomically save', async () => {
    await createBridge()
    await writeSessionBridge('drafting')
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const originalBytes = await fs.readFile(bridgePath)
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { projectId: 'occ-project-1' }
      if (name === 'get_edit_session') {
        return { editSessionId: 'edit-session-1', status: 'discarded' }
      }
      throw new Error(`unexpected tool: ${name}`)
    })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('disk echoed C:/private token=secret'),
    )
    try {
      const result = await runOpenChatCutSession({
        projectId: 'demo',
        action: 'status',
        openChatCutProjectId: 'occ-project-1',
        editSessionId: 'edit-session-1',
      })

      expect(result).toEqual({
        status: 'error',
        source: 'openchatcut',
        error: {
          code: 'bridge_persist_failed',
          message: '草案会话对账结果无法保存。请在可见编辑器中检查当前会话状态。',
          stage: 'session_reconcile',
          toolCode: 'bridge_persist',
        },
      })
      expect(JSON.stringify(result)).not.toContain('C:/private')
      expect(JSON.stringify(result)).not.toContain('token=secret')
      expect((await fs.readFile(bridgePath)).equals(originalBytes)).toBe(true)
    } finally {
      rename.mockRestore()
    }
  })

  it('gives only the begin draft transport five seconds beyond its managed deadlines', async () => {
    await createBridge()
    mocks.clientOptions.length = 0

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })

    expect(mocks.clientOptions).toHaveLength(1)
    expect(mocks.clientOptions[0]).toMatchObject({ timeoutMs: 95_000 })
  })

  it('derives the begin draft transport timeout from injected managed deadlines', async () => {
    await createBridge()
    mocks.clientOptions.length = 0

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessTimeoutMs: 40,
      projectStabilityTimeoutMs: 60,
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })

    expect(mocks.clientOptions[0]).toMatchObject({ timeoutMs: 5_060 })
  })

  it('keeps non-begin MCP clients on their default transport timeout', async () => {
    const created = await createBridge()
    expect(created).toMatchObject({ status: 'ok' })
    expect(mocks.clientOptions.at(-1)).not.toHaveProperty('timeoutMs')
  })

  it('recovers an exact applied session from durable state when MCP status fails', async () => {
    await createBridge()
    await writeSessionBridge('needs_review')
    const mcpTimeout = Object.assign(
      new Error('专业剪辑器响应超时。'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { ok: true, projectId: 'occ-project-1' }
      if (name === 'get_edit_session') throw mcpTimeout
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })
    mocks.getDurableEditSessionStatus.mockResolvedValue({
      editSessionId: 'edit-session-1',
      status: 'applied',
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'applied',
        editSessionId: 'edit-session-1',
      },
    })
    expect(mocks.getDurableEditSessionStatus).toHaveBeenCalledWith(
      'occ-project-1',
      'edit-session-1',
      { timeoutMs: 8_000 },
    )
  })

  it.each([
    {
      label: 'applied terminal status',
      remoteResult: { editSessionId: 'edit-session-1', status: 'applied' },
    },
    {
      label: 'rejected terminal status',
      remoteResult: { editSessionId: 'edit-session-1', status: 'rejected' },
    },
    {
      label: 'non-terminal status',
      remoteResult: { editSessionId: 'edit-session-1', status: 'awaiting_review' },
    },
    {
      label: 'missing session id',
      remoteResult: { status: 'discarded' },
    },
    {
      label: 'different session id',
      remoteResult: { editSessionId: 'other-session', status: 'discarded' },
    },
    {
      label: 'whitespace-wrapped session id',
      remoteResult: { editSessionId: ' edit-session-1 ', status: 'discarded' },
    },
    {
      label: 'whitespace-wrapped discarded status',
      remoteResult: { editSessionId: 'edit-session-1', status: ' discarded ' },
    },
    {
      label: 'missing status',
      remoteResult: { editSessionId: 'edit-session-1' },
    },
    {
      label: 'malformed tool error',
      remoteResult: { error: 'remote body must not leak' },
    },
  ])('does not report discarded for $label', async ({ remoteResult }) => {
    await createBridge()
    await writeSessionBridge()
    const originalBytes = await fs.readFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
    )
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { ok: true, projectId: 'occ-project-1' }
      if (name === 'discard_edit_session') return remoteResult
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'discard',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })

    expect(result).toEqual({
      status: 'error',
      source: 'openchatcut',
      error: {
        code: 'session_discard_unconfirmed',
        message: '专业剪辑器未能确认草案已放弃。请在可见编辑器中检查当前会话状态。',
        stage: 'session_discard',
        toolCode: 'discard_edit_session',
        recovery: {
          action: 'inspect_and_discard',
          editSessionId: 'edit-session-1',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('remote body')
    const currentBytes = await fs.readFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
    )
    expect(currentBytes.equals(originalBytes)).toBe(true)
  })

  it('persists discarded only after OpenChatCut confirms the exact session and status', async () => {
    await createBridge()
    await writeSessionBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { ok: true, projectId: 'occ-project-1' }
      if (name === 'discard_edit_session') {
        return { editSessionId: 'edit-session-1', status: 'discarded' }
      }
      if (name === 'get_editor_url') throw new Error('must not refresh editor URL')
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'discard',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'discarded',
        editSessionId: 'edit-session-1',
      },
    })
    await expect(readBridgeFile()).resolves.toMatchObject({
      phase: 'discarded',
      editSessionId: 'edit-session-1',
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('get_editor_url')
  })

  it('reports bridge persistence failure after an exact remote discard confirmation', async () => {
    await createBridge()
    await writeSessionBridge()
    const originalBytes = await fs.readFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
    )
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'target_project') return { ok: true, projectId: 'occ-project-1' }
      if (name === 'discard_edit_session') {
        return { editSessionId: 'edit-session-1', status: 'discarded' }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('disk echoed C:/private token=secret'),
    )
    try {
      const result = await runOpenChatCutSession({
        projectId: 'demo',
        action: 'discard',
        openChatCutProjectId: 'occ-project-1',
        editSessionId: 'edit-session-1',
      })

      expect(result).toEqual({
        status: 'error',
        source: 'openchatcut',
        error: {
          code: 'bridge_persist_failed',
          message: '草案会话结果无法保存。请在可见编辑器中检查当前会话状态。',
          stage: 'session_discard',
          toolCode: 'bridge_persist',
        },
      })
      expect(JSON.stringify(result)).not.toContain('C:/private')
      expect(JSON.stringify(result)).not.toContain('token=secret')
      const currentBytes = await fs.readFile(
        path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
      )
      expect(currentBytes.equals(originalBytes)).toBe(true)
      expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('get_editor_url')
    } finally {
      rename.mockRestore()
    }
  })

  function matchingEditStage(
    status: 'queued' | 'running' | 'ready' | 'failed',
    operationId = 'openchatcut-recovery-1',
    sessionId = 'openchatcut-export-recovery-1',
  ) {
    mocks.projectState.stages.edit = {
      status,
      ...(status === 'ready' ? { artifactId: operationId } : {}),
      source: 'openchatcut',
      operation: {
        id: operationId,
        sessionId,
        upstreamArtifactId: 'render-1',
        startedAt: new Date().toISOString(),
      },
      ...(status === 'failed'
        ? { error: { code: 'export_interrupted', message: '导出中断' } }
        : {}),
    }
  }

  async function writeRecoveredVideo(operationId = 'openchatcut-recovery-1') {
    const outputPath = path.join(root, 'artifacts', 'post-production', `${operationId}.mp4`)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'complete-mp4')
    return outputPath
  }

  it('targets the new project, stages a real validated edit and submits manual review', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '增强开场节奏',
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.bridge.phase).toBe('needs_review')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).toEqual([
      'target_project',
      'begin_edit_session',
      'read_project',
      'discard_edit_session',
      'begin_edit_session',
      'read_project',
      'get_edit_session',
      'read_project',
      'get_edit_session',
      'read_project',
      'get_edit_session',
      'read_project',
      'manage_timelines',
      'edit_item',
      'edit_item',
      'edit_captions',
      'review_edit_session',
      'get_editor_url',
    ])
    expect(mocks.callTool.mock.calls[13]?.[1]).toMatchObject({
      validateOnly: true,
      adds: [{
        type: 'effect',
        targetItemId: 'video-1',
        assetId: 'builtin:zoom',
        propertyOverrides: { shape: 'punch', magnification: 1.2 },
      }, {
        type: 'effect',
        targetItemId: 'video-1',
        assetId: 'builtin:look-fuji-portra',
        propertyOverrides: { intensity: 0.32 },
      }, {
        type: 'effect',
        targetItemId: 'video-1',
        assetId: 'builtin:fx-clarity',
        propertyOverrides: { amount: 0.18, radius: 16 },
      }],
    })
    expect(mocks.callTool.mock.calls[14]?.[1]).not.toHaveProperty('validateOnly')
    expect(mocks.callTool.mock.calls[15]?.[1]).toEqual({
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
      action: 'enable',
      preset: 'tiktok',
    })
    const ordinaryDraftTools = new Set([
      'target_project',
      'manage_timelines',
      'edit_item',
      'edit_captions',
      'review_edit_session',
      'get_editor_url',
    ])
    for (const [name, _args, options] of mocks.callTool.mock.calls) {
      if (ordinaryDraftTools.has(name)) {
        expect(options).toEqual({ timeoutMs: 8_000 })
      } else {
        expect(options).toBeUndefined()
      }
    }
  })

  it('recovers an acknowledged manual review when the MCP response times out', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const mcpTimeout = Object.assign(
      new Error('专业剪辑器响应超时。'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'review_edit_session') throw mcpTimeout
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })
    mocks.getDurableEditSessionStatus.mockResolvedValue({
      editSessionId: 'edit-session-1',
      status: 'awaiting_review',
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '增强开场节奏',
    })

    expect(result).toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'needs_review',
        editSessionId: 'edit-session-1',
      },
    })
    expect(mocks.getDurableEditSessionStatus).toHaveBeenCalledWith(
      'occ-project-1',
      'edit-session-1',
      { timeoutMs: 8_000 },
    )
    expect(
      mocks.callTool.mock.calls.filter(([name]) => name === 'discard_edit_session'),
    ).toHaveLength(1)
  })

  it('bounds draft mutations and does not claim discarded when cleanup times out', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const mcpTimeout = Object.assign(
      new Error('专业剪辑器响应超时。'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    let discardCalls = 0
    mocks.callTool.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') throw mcpTimeout
      if (name === 'discard_edit_session') {
        discardCalls += 1
        if (discardCalls > 1) throw mcpTimeout
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成精剪草案',
    })
    expect(result).toMatchObject({
      status: 'error',
    })
    if (result.status === 'error') {
      expect(result.error).toEqual({
        code: 'mcp_timeout',
        message: '专业剪辑器草案操作超时。',
        stage: 'draft_apply',
        toolCode: 'manage_timelines',
        recovery: {
          action: 'inspect_and_discard',
          editSessionId: 'edit-session-1',
        },
      })
      expect(JSON.stringify(result.error)).not.toContain('occ-project-1')
    }
    expect(mocks.callTool).toHaveBeenCalledWith(
      'manage_timelines',
      expect.any(Object),
      { timeoutMs: 8_000 },
    )
    expect(mocks.callTool).toHaveBeenCalledWith(
      'discard_edit_session',
      expect.any(Object),
      { timeoutMs: 8_000 },
    )
    await expect(readBridgeFile()).resolves.toMatchObject({
      phase: 'drafting',
      editSessionId: 'edit-session-1',
      instructions: ['草案生成失败，但未能确认编辑会话已放弃；请在可见编辑器中检查后重试放弃。'],
    })
  })

  it.each([
    {
      label: 'applied terminal status',
      cleanupResult: { editSessionId: 'edit-session-1', status: 'applied' },
    },
    {
      label: 'rejected terminal status',
      cleanupResult: { editSessionId: 'edit-session-1', status: 'rejected' },
    },
    {
      label: 'awaiting review status',
      cleanupResult: { editSessionId: 'edit-session-1', status: 'awaiting_review' },
    },
    {
      label: 'different session id',
      cleanupResult: { editSessionId: 'other-session', status: 'discarded' },
    },
    {
      label: 'missing session id',
      cleanupResult: { status: 'discarded' },
    },
    {
      label: 'missing status',
      cleanupResult: { editSessionId: 'edit-session-1' },
    },
    {
      label: 'whitespace-wrapped session id',
      cleanupResult: { editSessionId: ' edit-session-1 ', status: 'discarded' },
    },
    {
      label: 'whitespace-wrapped status',
      cleanupResult: { editSessionId: 'edit-session-1', status: ' discarded ' },
    },
    {
      label: 'malformed tool error',
      cleanupResult: { error: 'remote cleanup body token=secret must not leak' },
    },
  ])('keeps cleanup recoverable for $label', async ({ cleanupResult }) => {
    await createBridge()
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const beforeBytes = await fs.readFile(bridgePath)
    mocks.callTool.mockClear()
    const rootTimeout = Object.assign(
      new Error('root timeout body must not leak'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    let discardCalls = 0
    mocks.callTool.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') throw rootTimeout
      if (name === 'discard_edit_session') {
        discardCalls += 1
        return discardCalls === 1
          ? { editSessionId: args.editSessionId, status: 'discarded' }
          : cleanupResult
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成精剪草案',
    })

    expect(result).toEqual({
      status: 'error',
      source: 'openchatcut',
      error: {
        code: 'mcp_timeout',
        message: '专业剪辑器草案操作超时。',
        stage: 'draft_apply',
        toolCode: 'manage_timelines',
        recovery: {
          action: 'inspect_and_discard',
          editSessionId: 'edit-session-1',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('remote cleanup body')
    expect(JSON.stringify(result)).not.toContain('root timeout body')
    expect(JSON.stringify(result)).not.toContain('token=secret')
    const afterBytes = await fs.readFile(bridgePath)
    expect(afterBytes.equals(beforeBytes)).toBe(false)
    expect(afterBytes.toString('utf8')).toContain('"phase": "drafting"')
    expect(afterBytes.toString('utf8')).not.toContain('"phase": "discarded"')
    await expect(readBridgeFile()).resolves.toMatchObject({
      phase: 'drafting',
      editSessionId: 'edit-session-1',
    })
  })

  it('persists discarded after failed draft apply only for the exact cleanup confirmation', async () => {
    await createBridge()
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const beforeBytes = await fs.readFile(bridgePath)
    mocks.callTool.mockClear()
    const rootTimeout = Object.assign(
      new Error('root timeout body must not leak'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    mocks.callTool.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') throw rootTimeout
      if (name === 'discard_edit_session') {
        return { editSessionId: args.editSessionId, status: 'discarded' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成精剪草案',
    })

    expect(result).toEqual({
      status: 'error',
      source: 'openchatcut',
      error: {
        code: 'mcp_timeout',
        message: '专业剪辑器草案操作超时。',
        stage: 'draft_apply',
        toolCode: 'manage_timelines',
      },
    })
    expect(JSON.stringify(result)).not.toContain('root timeout body')
    const afterBytes = await fs.readFile(bridgePath)
    expect(afterBytes.equals(beforeBytes)).toBe(false)
    expect(afterBytes.toString('utf8')).toContain('"phase": "discarded"')
    await expect(readBridgeFile()).resolves.toMatchObject({
      phase: 'discarded',
      editSessionId: 'edit-session-1',
    })
  })

  it('reports bridge persistence failure after an exact failed-draft cleanup confirmation', async () => {
    await createBridge()
    const bridgePath = path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json')
    const beforeBytes = await fs.readFile(bridgePath)
    mocks.callTool.mockClear()
    const rootTimeout = Object.assign(
      new Error('root timeout body must not leak'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    mocks.callTool.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') throw rootTimeout
      if (name === 'discard_edit_session') {
        return { editSessionId: args.editSessionId, status: 'discarded' }
      }
      return { ok: true }
    })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('disk echoed C:/private token=secret'),
    )
    try {
      const result = await runOpenChatCutSession({
        projectId: 'demo',
        action: 'begin',
        openChatCutProjectId: 'occ-project-1',
        request: '生成精剪草案',
      })

      expect(result).toEqual({
        status: 'error',
        source: 'openchatcut',
        error: {
          code: 'bridge_persist_failed',
          message: '草案会话结果无法保存。请在可见编辑器中检查当前会话状态。',
          stage: 'draft_cleanup',
          toolCode: 'bridge_persist',
        },
      })
      expect(JSON.stringify(result)).not.toContain('C:/private')
      expect(JSON.stringify(result)).not.toContain('token=secret')
      const afterBytes = await fs.readFile(bridgePath)
      expect(afterBytes.equals(beforeBytes)).toBe(true)
      expect(afterBytes.toString('utf8')).not.toContain('"phase": "discarded"')
    } finally {
      rename.mockRestore()
    }
  })

  it.each([
    {
      label: 'RPC message',
      expectedCode: 'rpc_error',
      failure: () => {
        throw Object.assign(
          new Error('rpc echoed occ-project-1 edit-session-1 token=secret params=private'),
          { name: 'OpenChatCutMcpError', code: 'rpc_error' },
        )
      },
    },
    {
      label: 'structured tool error',
      expectedCode: 'tool_error',
      failure: () => ({
        error: 'structured echoed occ-project-1 edit-session-1 token=secret params=private',
      }),
    },
    {
      label: 'unrecognized error code',
      expectedCode: 'unexpected_error',
      failure: () => {
        throw Object.assign(
          new Error('unknown echoed occ-project-1 edit-session-1 token=secret params=private'),
          { name: 'OpenChatCutMcpError', code: 'token=secret' },
        )
      },
    },
  ])('redacts malicious $label from public draft errors', async ({ expectedCode, failure }) => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') return failure()
      if (name === 'discard_edit_session') {
        return { editSessionId: args.editSessionId, status: 'discarded' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成精剪草案',
    })
    expect(result).toMatchObject({ status: 'error' })
    if (result.status === 'error') {
      expect(result.error).toEqual({
        code: expectedCode,
        message: '专业剪辑器未能完成受控草案操作。',
        stage: 'draft_apply',
        toolCode: 'manage_timelines',
      })
      const publicError = JSON.stringify(result.error)
      expect(publicError).not.toContain('occ-project-1')
      expect(publicError).not.toContain('edit-session-1')
      expect(publicError).not.toContain('token=secret')
      expect(publicError).not.toContain('params=private')
    }
  })

  it('returns a safe recovery reference when an unconfirmed cleanup bridge cannot persist', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const mcpTimeout = Object.assign(
      new Error('transport echoed token=secret'),
      { name: 'OpenChatCutMcpError', code: 'mcp_timeout' },
    )
    let discardCalls = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              transcript: [{ text: '你好', start: 0, end: 500 }],
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'manage_timelines') throw mcpTimeout
      if (name === 'discard_edit_session') {
        discardCalls += 1
        if (discardCalls > 1) throw mcpTimeout
      }
      return { ok: true }
    })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error('disk echoed C:/private token=secret'),
    )
    try {
      const result = await runOpenChatCutSession({
        projectId: 'demo',
        action: 'begin',
        openChatCutProjectId: 'occ-project-1',
        request: '生成精剪草案',
      })
      expect(result).toEqual({
        status: 'error',
        source: 'openchatcut',
        error: {
          code: 'bridge_persist_failed',
          message: '草案会话状态无法保存。请在可见编辑器中检查并手动放弃该会话。',
          stage: 'draft_cleanup',
          toolCode: 'bridge_persist',
          recovery: {
            action: 'inspect_and_discard',
            editSessionId: 'edit-session-1',
          },
        },
      })
      expect(JSON.stringify(result)).not.toContain('C:/private')
      expect(JSON.stringify(result)).not.toContain('token=secret')
      expect((await readBridgeFile()).phase).not.toBe('discarded')
    } finally {
      rename.mockRestore()
    }
  })

  it.each([
    {
      label: 'natural clean',
      preset: 'clean' as const,
      colorGrade: 'natural' as const,
      expectedAssetIds: ['builtin:zoom'],
    },
    {
      label: 'warm clean',
      preset: 'clean' as const,
      colorGrade: 'warm' as const,
      expectedAssetIds: ['builtin:zoom', 'builtin:look-warm'],
    },
    {
      label: 'natural cinematic',
      preset: 'cinematic' as const,
      colorGrade: 'natural' as const,
      expectedAssetIds: ['builtin:zoom', 'builtin:fx-vignette', 'builtin:fx-film-grain'],
    },
  ])('maps $label to fixed built-in OpenChatCut effects', async ({
    preset,
    colorGrade,
    expectedAssetIds,
  }) => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.generatePlan.mockResolvedValueOnce({
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan: {
        ...createDefaultEditPlan(),
        creative: {
          ...createDefaultEditPlan().creative,
          preset,
          colorGrade,
        },
      },
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '应用固定风格',
    })).resolves.toMatchObject({ status: 'ok' })
    const validation = mocks.callTool.mock.calls.find(
      ([name, args]) => name === 'edit_item' && args.validateOnly === true,
    )?.[1] as { adds?: Array<{ assetId?: string }> } | undefined
    expect(validation?.adds?.map(({ assetId }) => assetId)).toEqual(expectedAssetIds)
  })

  it.each([
    { label: 'impact captions', captions: 'impact' as const, style: 'clean' as const, effects: [], preset: 'tiktok' },
    { label: 'animated captions', captions: 'static' as const, style: 'clean' as const, effects: ['animated-captions'] as const, preset: 'tiktok' },
    { label: 'karaoke captions', captions: 'karaoke' as const, style: 'clean' as const, effects: [], preset: 'bili' },
    { label: 'cyan captions', captions: 'static' as const, style: 'cyan' as const, effects: [], preset: 'bili' },
    { label: 'bold captions', captions: 'static' as const, style: 'bold' as const, effects: [], preset: 'bold-outline' },
    { label: 'clean captions', captions: 'static' as const, style: 'clean' as const, effects: [], preset: 'netflix' },
  ])('maps $label to a fixed caption preset', async ({
    captions,
    style,
    effects,
    preset,
  }) => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.generatePlan.mockResolvedValueOnce({
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan: {
        ...createDefaultEditPlan(),
        subtitles: {
          ...createDefaultEditPlan().subtitles,
          style,
        },
        creative: {
          ...createDefaultEditPlan().creative,
          captions,
          effects: [...effects],
        },
      },
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '应用字幕风格',
    })).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.callTool).toHaveBeenCalledWith('edit_captions', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
      action: 'enable',
      preset,
    }, { timeoutMs: 8_000 })
  })

  it('discards the session when the user has not imported video', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') return { timeline: { id: 'timeline-1', items: [] } }
      return { ok: true }
    })
    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '增强开场节奏',
    })
    expect(result).toMatchObject({ status: 'error', error: { code: 'media_not_imported' } })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
  })

  it('discards the manual session with a stable error when captions have no transcript words', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') return {
        timeline: {
          id: 'timeline-1',
          fps: 30,
          items: [{
            id: 'video-1',
            kind: 'video',
            src: '/media/uploads/current.mp4',
            startFrame: 0,
            durationInFrames: 360,
            hasTranscript: false,
          }],
        },
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => {
      expect(mocks.callTool.mock.calls.map(([name]) => name)).toContain('read_project')
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('edit_captions')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('creates one sanitized no-caption draft when structured transcription reports HTTP 401', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.listTools.mockResolvedValue([{
      name: 'track_progress',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['generation', 'transcription'] },
          assetIds: { type: 'string' },
        },
      },
    }])
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project' && args.view === 'assets') {
        return {
          mediaPool: {
            assets: [{
              id: 'asset-current',
              kind: 'video',
              src: '/media/uploads/current.mp4',
            }],
          },
        }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      if (name === 'track_progress') {
        return {
          ok: true,
          target: 'transcription',
          action: 'status',
          reports: [{
            assetId: 'asset-current',
            status: 'failed',
            error: 'upload failed: HTTP 401 api-key=must-not-leak',
          }],
        }
      }
      if (name === 'get_edit_session') return { status: 'draft', stale: false }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '增强开场节奏并生成字幕',
    })

    expect(result).toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'needs_review',
      },
    })
    await expect(readBridgeFile()).resolves.toMatchObject({
      currentPlan: { subtitles: { enabled: false } },
    })
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
    expect(mocks.generatePlan.mock.calls[0]?.[0]).toMatchObject({
      currentPlan: { subtitles: { enabled: false } },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('track_progress', {
      action: 'status',
      target: 'transcription',
      assetIds: 'asset-current',
    })
    expect(mocks.callTool).toHaveBeenCalledWith('edit_captions', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
      action: 'disable',
    }, { timeoutMs: 8_000 })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('transcribe_track')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('retry_transcription')
    if (result.status === 'ok') {
      expect(result.bridge.instructions[0]).toBe(
        'OpenChatCut转写服务凭据失效，本次草案不含自动字幕，可配置后重试。',
      )
      expect(JSON.stringify(result.bridge)).not.toContain('must-not-leak')
      expect(JSON.stringify(result.bridge)).not.toContain('api-key')
    }
  })

  it('uses the sanitized exact-project CDP fallback when the MCP schema lacks transcription', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.listTools.mockResolvedValue([])
    mocks.inspectTranscription.mockResolvedValue({
      status: 'failed',
      errorCode: 'auth',
      transcribeError: 'must-not-be-observable',
    })
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'draft', stale: false }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成安全草案',
    })

    expect(result).toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'needs_review',
      },
    })
    if (result.status === 'ok') {
      expect(result.bridge.instructions[0]).toBe(
        'OpenChatCut转写服务凭据失效，本次草案不含自动字幕，可配置后重试。',
      )
    }
    expect(mocks.inspectTranscription).toHaveBeenCalledWith({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
      openChatCutProjectId: 'occ-project-1',
      expectedSrc: '/media/uploads/current.mp4',
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('track_progress')
    expect(JSON.stringify(result)).not.toContain('must-not-be-observable')
  })

  it.each(['running', 'succeeded'] as const)(
    'does not spend a Provider request when structured transcription is $status but words are absent',
    async (status) => {
      await createBridge()
      mocks.callTool.mockClear()
      mocks.listTools.mockResolvedValue([{
        name: 'track_progress',
        inputSchema: {
          type: 'object',
          properties: {
            target: { enum: ['generation', 'transcription'] },
            assetIds: { type: 'string' },
          },
        },
      }])
      const clock = new VirtualManagedWaitClock()
      mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        if (name === 'begin_edit_session') return { editSessionId: 'readiness-session' }
        if (name === 'read_project' && args.view === 'assets') {
          return {
            mediaPool: {
              assets: [{
                id: 'asset-current',
                src: '/media/uploads/current.mp4',
              }],
            },
          }
        }
        if (name === 'read_project') {
          return {
            timeline: {
              id: 'timeline-1',
              fps: 30,
              items: [{
                id: 'video-1',
                kind: 'video',
                src: '/media/uploads/current.mp4',
                startFrame: 0,
                durationInFrames: 360,
                hasTranscript: false,
              }],
            },
          }
        }
        if (name === 'track_progress') {
          return {
            ok: true,
            reports: [{ assetId: 'asset-current', status }],
          }
        }
        return { ok: true }
      })

      const pending = runOpenChatCutSession({
        projectId: 'demo',
        action: 'begin',
        openChatCutProjectId: 'occ-project-1',
        request: '生成字幕草案',
      }, {
        captionReadinessClock: clock,
        captionReadinessTimeoutMs: 20,
        captionReadinessIntervalMs: 5,
      })
      await vi.waitFor(() => {
        expect(mocks.callTool.mock.calls.map(([name]) => name)).toContain('track_progress')
      })
      expect(mocks.generatePlan).not.toHaveBeenCalled()
      await clock.advance(20)

      await expect(pending).resolves.toMatchObject({
        status: 'error',
        error: { code: 'captions_not_ready' },
      })
      expect(mocks.generatePlan).not.toHaveBeenCalled()
    },
  )

  it('fails closed before the Provider when the transcription asset or report identity mismatches', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.listTools.mockResolvedValue([{
      name: 'track_progress',
      inputSchema: {
        properties: {
          target: { enum: ['transcription'] },
          assetIds: { type: 'string' },
        },
      },
    }])
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') return { editSessionId: 'readiness-session' }
      if (name === 'read_project' && args.view === 'assets') {
        return {
          mediaPool: {
            assets: [{
              id: 'asset-other',
              src: '/media/uploads/other.mp4',
            }],
          },
        }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成字幕草案',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'media_import_unverified' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('track_progress')
  })

  it('rejects a transcription report for another asset without exposing its raw error', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.listTools.mockResolvedValue([{
      name: 'track_progress',
      inputSchema: {
        properties: {
          target: { enum: ['transcription'] },
          assetIds: { type: 'string' },
        },
      },
    }])
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') return { editSessionId: 'readiness-session' }
      if (name === 'read_project' && args.view === 'assets') {
        return {
          mediaPool: {
            assets: [{
              id: 'asset-current',
              src: '/media/uploads/current.mp4',
            }],
          },
        }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      if (name === 'track_progress') {
        return {
          ok: true,
          reports: [{
            assetId: 'asset-other',
            status: 'failed',
            error: 'HTTP 401 secret=must-not-leak',
          }],
        }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成字幕草案',
    })
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'transcription_status_invalid' },
    })
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(mocks.generatePlan).not.toHaveBeenCalled()
  })

  it('waits for the structured transcript before spending an AI Provider request', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: reads > 1,
            }],
          },
        }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 50,
      captionReadinessIntervalMs: 10,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    expect(mocks.generatePlan).not.toHaveBeenCalled()

    await clock.advance(10)
    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
    expect(reads).toBe(6)
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('reopens a disposable readiness session only when the same session structurally reports stale', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let beginCount = 0
    const events: string[] = []
    mocks.generatePlan.mockImplementationOnce(async () => {
      events.push('provider')
      return {
        status: 'ok',
        source: 'ai_edit_plan_agent',
        plan: createDefaultEditPlan(),
      }
    })
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        events.push(`read-${args.editSessionId}`)
        if (args.editSessionId === 'session-1') {
          return { error: 'opaque read failure that must not be parsed' }
        }
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session' && args.editSessionId === 'session-1') {
        return { status: 'drafting', stale: true }
      }
      if (name === 'discard_edit_session') events.push(`discard-${args.editSessionId}`)
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
    expect(events.indexOf('discard-session-1')).toBeLessThan(events.indexOf('read-session-2'))
    expect(events.indexOf('discard-session-2')).toBeLessThan(events.indexOf('provider'))
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('retries a precisely classified readiness timeout after discarding its session', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project' && args.editSessionId === 'session-1') {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'session-3' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-1',
    })
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('bounds continuous readiness timeouts and never calls the Provider', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => expect(beginCount).toBe(1))
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(beginCount).toBeGreaterThan(1)
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('does not hide a discard failure after a readiness timeout', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'session-1' }
      if (name === 'read_project') {
        throw new DOMException('The operation was aborted due to timeout', 'AbortError')
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'discard_edit_session') return { error: 'discard failed exactly' }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'tool_error', message: 'discard failed exactly' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
  })

  it('accepts a timed-out discard only when the same session structurally confirms discarded', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const normalizedTimeout = await realNormalizedMcpTimeoutError()
    expect(normalizedTimeout).toMatchObject({
      name: 'OpenChatCutMcpError',
      code: 'mcp_timeout',
    })
    let beginCount = 0
    let statusCount = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project' && args.editSessionId === 'session-1') {
        throw normalizedTimeout
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session' && args.editSessionId === 'session-1') {
        statusCount += 1
        return statusCount === 1
          ? { status: 'drafting', stale: false }
          : { status: 'discarded', stale: false }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'discard_edit_session' && args.editSessionId === 'session-1') {
        throw normalizedTimeout
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'session-3' },
    })
    expect(statusCount).toBe(2)
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('preserves a timed-out discard when the session does not confirm discarded', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'session-1' }
      if (name === 'read_project') {
        throw new DOMException('read body timed out', 'TimeoutError')
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      if (name === 'discard_edit_session') {
        throw new DOMException('discard body timed out exactly', 'TimeoutError')
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'unexpected_error',
        message: 'discard body timed out exactly',
      },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'transcript-ready', hasTranscript: true, authUnavailable: false },
    { label: 'auth-degraded', hasTranscript: false, authUnavailable: true },
  ])(
    'never continues from $label readiness when disposable-session discard is unconfirmed',
    async ({ hasTranscript, authUnavailable }) => {
      await createBridge()
      mocks.callTool.mockClear()
      const clock = new VirtualManagedWaitClock()
      if (authUnavailable) {
        mocks.listTools.mockResolvedValue([])
        mocks.inspectTranscription.mockResolvedValue({
          status: 'failed',
          errorCode: 'auth',
        })
      }
      mocks.callTool.mockImplementation(async (name: string) => {
        if (name === 'begin_edit_session') return { editSessionId: 'readiness-session' }
        if (name === 'read_project') {
          return {
            timeline: {
              id: 'timeline-1',
              fps: 30,
              items: [{
                id: 'video-1',
                kind: 'video',
                src: '/media/uploads/current.mp4',
                startFrame: 0,
                durationInFrames: 360,
                hasTranscript,
              }],
            },
          }
        }
        if (name === 'discard_edit_session') return await new Promise(() => undefined)
        return { ok: true }
      })

      const pending = runOpenChatCutSession({
        projectId: 'demo',
        action: 'begin',
        openChatCutProjectId: 'occ-project-1',
        request: '生成字幕草案',
      }, {
        captionReadinessClock: clock,
        captionReadinessTimeoutMs: 20,
        captionReadinessIntervalMs: 5,
      })
      await vi.waitFor(() => {
        expect(mocks.callTool.mock.calls.map(([name]) => name)).toContain('discard_edit_session')
      })
      await clock.advance(20)

      await expect(pending).resolves.toMatchObject({
        status: 'error',
        error: { code: 'captions_not_ready' },
      })
      expect(mocks.generatePlan).not.toHaveBeenCalled()
      expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
      expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
    },
  )

  it('bounds permanently stale disposable readiness sessions without calling the Provider', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') return { error: 'opaque read failure' }
      if (name === 'get_edit_session') return { status: 'drafting', stale: true }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => expect(beginCount).toBe(1))
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(beginCount).toBeGreaterThan(1)
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
  })

  it('preserves a non-stale readiness read error without retrying or calling the Provider', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const actual = await vi.importActual<typeof import('./mcp-client')>('./mcp-client')
    const normalizedNetworkError = new actual.OpenChatCutMcpError(
      'network_error',
      'real normalized non-timeout failure',
    )
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') throw normalizedNetworkError
      if (name === 'get_edit_session') return { status: 'drafting', stale: false }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'network_error', message: 'real normalized non-timeout failure' },
    })
    expect(beginCount).toBe(1)
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-1',
    })
  })

  it('reopens a fresh manual session after caption readiness before applying edits', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    const events: string[] = []
    let beginCount = 0
    let readinessReads = 0
    mocks.generatePlan.mockImplementationOnce(async () => {
      events.push('provider')
      return {
        status: 'ok',
        source: 'ai_edit_plan_agent',
        plan: createDefaultEditPlan(),
      }
    })
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        events.push(`begin-${beginCount}`)
        return {
          editSessionId: beginCount <= 2
            ? `readiness-session-${beginCount}`
            : 'fresh-session',
        }
      }
      if (name === 'read_project') {
        events.push(`read-${args.editSessionId}`)
        if (String(args.editSessionId).startsWith('readiness-session-')) readinessReads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: args.editSessionId === 'fresh-session' || readinessReads > 1,
            }],
          },
        }
      }
      if (name === 'discard_edit_session') events.push(`discard-${args.editSessionId}`)
      if (name === 'manage_timelines') events.push(`manage-${args.editSessionId}`)
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 50,
      captionReadinessIntervalMs: 10,
    })
    await vi.waitFor(() => expect(readinessReads).toBe(1))
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'fresh-session' },
    })
    expect(events.indexOf('read-readiness-session-1')).toBeLessThan(events.indexOf('provider'))
    expect(events.indexOf('discard-readiness-session-2')).toBeLessThan(events.indexOf('provider'))
    expect(events.indexOf('provider')).toBeLessThan(events.indexOf('begin-3'))
    expect(events.indexOf('read-fresh-session')).toBeLessThan(events.indexOf('manage-fresh-session'))
    expect(mocks.callTool).toHaveBeenCalledWith('review_edit_session', expect.objectContaining({
      editSessionId: 'fresh-session',
    }), { timeoutMs: 8_000 })
  })

  it('discards the fresh session when its timeline identity changed before edits', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: beginCount === 1 ? 'readiness-session' : 'fresh-session' }
      }
      if (name === 'read_project') {
        const fresh = args.editSessionId === 'fresh-session'
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: fresh ? 'replacement-video' : 'video-1',
              kind: 'video',
              src: fresh
                ? '/media/uploads/replacement.mp4'
                : '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'media_import_unverified' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'fresh-session',
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('uses the first structurally stable disposable session without rerunning the Provider', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    const statusCounts = new Map<string, number>()
    const readCounts = new Map<string, number>()
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        const editSessionId = String(args.editSessionId)
        readCounts.set(editSessionId, (readCounts.get(editSessionId) ?? 0) + 1)
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') {
        const editSessionId = String(args.editSessionId)
        const count = (statusCounts.get(editSessionId) ?? 0) + 1
        statusCounts.set(editSessionId, count)
        return {
          status: 'drafting',
          stale: editSessionId === 'session-2' && count === 2,
        }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      projectStabilityClock: clock,
      projectStabilityTimeoutMs: 90,
      projectStabilityQuiescenceMs: 10,
    })
    await vi.waitFor(() => expect(beginCount).toBe(2))
    await clock.advance(10)
    expect(beginCount).toBe(2)
    await clock.advance(10)
    await vi.waitFor(() => expect(beginCount).toBe(3))
    await clock.advance(10)
    await clock.advance(10)
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'session-3' },
    })
    expect(mocks.generatePlan).toHaveBeenCalledTimes(1)
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-2',
    })
    expect(statusCounts.get('session-3')).toBe(3)
    expect(readCounts.get('session-3')).toBe(4)
    expect(mocks.callTool).toHaveBeenCalledWith('manage_timelines', expect.objectContaining({
      editSessionId: 'session-3',
    }), { timeoutMs: 8_000 })
    const calls = mocks.callTool.mock.calls
    const lastStableRead = calls.findLastIndex(([name, args]) =>
      name === 'read_project' && args.editSessionId === 'session-3')
    const firstMutation = calls.findIndex(([name]) => name === 'manage_timelines')
    expect(lastStableRead).toBe(firstMutation - 1)
  })

  it('reopens a stability session when its failed initial read is structurally stale', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        if (args.editSessionId === 'session-2') {
          return { error: 'opaque failed initial read' }
        }
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') {
        return {
          status: 'drafting',
          stale: args.editSessionId === 'session-2',
        }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'session-3' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-2',
    })
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('reopens a stability session when a failed confirmation read is structurally stale', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let beginCount = 0
    const readCounts = new Map<string, number>()
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        const editSessionId = String(args.editSessionId)
        const count = (readCounts.get(editSessionId) ?? 0) + 1
        readCounts.set(editSessionId, count)
        if (editSessionId === 'session-2' && count === 2) {
          return { error: 'opaque failed confirmation read' }
        }
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') {
        return {
          status: 'drafting',
          stale: args.editSessionId === 'session-2' && readCounts.get('session-2') === 2,
        }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review', editSessionId: 'session-3' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-2',
    })
    expect(mocks.generatePlan).toHaveBeenCalledOnce()
  })

  it('fails without mutations when every disposable session remains stale', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') return { status: 'drafting', stale: true }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      projectStabilityClock: clock,
      projectStabilityTimeoutMs: 25,
      projectStabilityQuiescenceMs: 5,
    })
    await vi.waitFor(() => expect(beginCount).toBe(2))
    await clock.advance(25)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'project_not_stable' },
    })
    expect(mocks.generatePlan).toHaveBeenCalledTimes(1)
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('fails closed when a stale stability session cannot confirm its discard before deadline', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return {
          editSessionId: beginCount === 1 ? 'readiness-session' : 'stability-session',
        }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session' && args.editSessionId === 'stability-session') {
        return { status: 'drafting', stale: true }
      }
      if (name === 'discard_edit_session' && args.editSessionId === 'stability-session') {
        return await new Promise<Record<string, unknown>>(() => undefined)
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      projectStabilityClock: clock,
      projectStabilityTimeoutMs: 20,
      projectStabilityQuiescenceMs: 5,
    })
    await vi.waitFor(() => expect(beginCount).toBe(2))
    await clock.advance(5)
    await vi.waitFor(() => {
      expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
        editorProjectId: 'occ-project-1',
        editSessionId: 'stability-session',
      })
    })
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'project_not_stable' },
    })
    expect(beginCount).toBe(2)
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('bounds a permanently pending stability probe and discards its session', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let stabilitySessionId = ''
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        const editSessionId = stabilitySessionId ? 'unexpected-session' : (
          mocks.generatePlan.mock.calls.length ? 'stability-session' : 'readiness-session'
        )
        if (editSessionId === 'stability-session') stabilitySessionId = editSessionId
        return { editSessionId }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session' && args.editSessionId === 'stability-session') {
        return await new Promise<Record<string, unknown>>(() => undefined)
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      projectStabilityClock: clock,
      projectStabilityTimeoutMs: 20,
      projectStabilityQuiescenceMs: 5,
    })
    await vi.waitFor(() => expect(stabilitySessionId).toBe('stability-session'))
    await clock.advance(5)
    await vi.waitFor(() => {
      expect(mocks.callTool.mock.calls.some(([name]) => name === 'get_edit_session')).toBe(true)
    })
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'project_not_stable' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'stability-session',
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
  })

  it('does not accept a stability result that resolves after the monotonic deadline', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    let resolveLate!: (value: Record<string, unknown>) => void
    const lateStatus = new Promise<Record<string, unknown>>((resolve) => {
      resolveLate = resolve
    })
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `session-${beginCount}` }
      }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: true,
            }],
          },
        }
      }
      if (name === 'get_edit_session') return await lateStatus
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      projectStabilityClock: clock,
      projectStabilityTimeoutMs: 20,
      projectStabilityQuiescenceMs: 5,
    })
    await vi.waitFor(() => expect(beginCount).toBe(2))
    await clock.advance(5)
    await vi.waitFor(() => {
      expect(mocks.callTool.mock.calls.some(([name]) => name === 'get_edit_session')).toBe(true)
    })
    clock.jump(21)
    resolveLate({ status: 'drafting', stale: false })
    await clock.flush()

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'project_not_stable' },
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('manage_timelines')
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'session-2',
    })
  })

  it('rejects a replaced timeline video while waiting for transcript readiness', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        return {
          timeline: {
            id: reads === 1 ? 'timeline-1' : 'timeline-replaced',
            fps: 30,
            items: [{
              id: reads === 1 ? 'video-1' : 'video-replaced',
              kind: 'video',
              src: reads === 1
                ? '/media/uploads/current.mp4'
                : '/media/uploads/replaced.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: reads > 1,
            }],
          },
        }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 50,
      captionReadinessIntervalMs: 10,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'media_import_unverified' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
  })

  it('rejects a duration change during transcript readiness even within import tolerance', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: reads === 1 ? 360 : 390,
              hasTranscript: reads > 1,
            }],
          },
        }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 50,
      captionReadinessIntervalMs: 10,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'media_import_unverified' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
  })

  it('times out a permanently pending transcript read without calling the Provider', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        if (reads > 1) return new Promise<Record<string, unknown>>(() => undefined)
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    await clock.advance(20)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(reads).toBe(2)
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
  })

  it('bounds the first transcript project read with the same monotonic deadline', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        return new Promise<Record<string, unknown>>(() => undefined)
      }
      return { ok: true }
    })

    let settled = false
    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    }).finally(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(mocks.callTool.mock.calls.map(([name]) => name)).toContain('read_project')
    })
    await clock.advance(20)

    await vi.waitFor(() => expect(settled).toBe(true))
    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
  })

  it('does not accept a transcript result that resolves after the monotonic deadline', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    let resolveLate!: (value: Record<string, unknown>) => void
    const lateRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveLate = resolve
    })
    const projectOverview = (hasTranscript: boolean) => ({
      timeline: {
        id: 'timeline-1',
        fps: 30,
        items: [{
          id: 'video-1',
          kind: 'video',
          src: '/media/uploads/current.mp4',
          startFrame: 0,
          durationInFrames: 360,
          hasTranscript,
        }],
      },
    })
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        return reads === 1 ? projectOverview(false) : lateRead
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    await clock.advance(5)
    expect(reads).toBe(2)
    clock.jump(21)
    resolveLate(projectOverview(true))
    await clock.flush()

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
  })

  it('observes a transcript read that rejects after the monotonic deadline', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let reads = 0
    let rejectLate!: (reason: unknown) => void
    const lateRead = new Promise<Record<string, unknown>>((_resolve, reject) => {
      rejectLate = reject
    })
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        if (reads > 1) return lateRead
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: false,
            }],
          },
        }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成动态字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 20,
      captionReadinessIntervalMs: 5,
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    await clock.advance(5)
    expect(reads).toBe(2)
    clock.jump(21)
    rejectLate(new Error('late transcription failure'))
    await clock.flush()

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'captions_not_ready' },
    })
    expect(mocks.generatePlan).not.toHaveBeenCalled()
  })

  it('can disable captions without requiring transcript words', async () => {
    const captionsDisabledPlan = {
      ...createDefaultEditPlan(),
      subtitles: {
        ...createDefaultEditPlan().subtitles,
        enabled: false,
      },
    }
    mocks.projectState.stages.edit = { status: 'ready', artifactId: 'edit-1' }
    mocks.getPostArtifact.mockResolvedValue({
      artifactId: 'edit-1',
      status: 'ready',
      source: 'local',
      sessionId: 'local-edit-1',
      renderArtifactId: 'render-1',
      scriptArtifactId: 'script-1',
      durationSeconds: 12,
      outputPath: path.join(root, 'artifacts', 'post-production', 'edit-1.mp4'),
      parameters: { plan: captionsDisabledPlan, request: '关闭字幕' },
    })
    await createBridge()
    mocks.callTool.mockClear()
    mocks.generatePlan.mockResolvedValueOnce({
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan: captionsDisabledPlan,
    })
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') {
        reads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
            }],
          },
        }
      }
      if (name === 'get_editor_url') return {
        editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '不要字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('edit_captions', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
      action: 'disable',
    }, { timeoutMs: 8_000 })
    expect(reads).toBe(5)
  })

  it('waits after the Provider when a captions-disabled plan is changed to enable captions', async () => {
    const captionsDisabledPlan = {
      ...createDefaultEditPlan(),
      subtitles: {
        ...createDefaultEditPlan().subtitles,
        enabled: false,
      },
    }
    mocks.projectState.stages.edit = { status: 'ready', artifactId: 'edit-1' }
    mocks.getPostArtifact.mockResolvedValue({
      artifactId: 'edit-1',
      status: 'ready',
      source: 'local',
      sessionId: 'local-edit-1',
      renderArtifactId: 'render-1',
      scriptArtifactId: 'script-1',
      durationSeconds: 12,
      outputPath: path.join(root, 'artifacts', 'post-production', 'edit-1.mp4'),
      parameters: { plan: captionsDisabledPlan, request: '关闭字幕' },
    })
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    let beginCount = 0
    let readinessReads = 0
    mocks.generatePlan.mockResolvedValueOnce({
      status: 'ok',
      source: 'ai_edit_plan_agent',
      plan: createDefaultEditPlan(),
    })
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_edit_session') {
        beginCount += 1
        return { editSessionId: `edit-session-${beginCount}` }
      }
      if (name === 'read_project') {
        const sessionNumber = Number(String(args.editSessionId).split('-').at(-1))
        if (sessionNumber === 2 || sessionNumber === 3) readinessReads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: [{
              id: 'video-1',
              kind: 'video',
              src: '/media/uploads/current.mp4',
              startFrame: 0,
              durationInFrames: 360,
              hasTranscript: readinessReads > 1 || sessionNumber >= 4,
            }],
          },
        }
      }
      if (name === 'get_editor_url') {
        return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      }
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '重新开启字幕',
    }, {
      captionReadinessClock: clock,
      captionReadinessTimeoutMs: 50,
      captionReadinessIntervalMs: 10,
    })
    await vi.waitFor(() => {
      expect(readinessReads).toBe(1)
      expect(mocks.generatePlan).toHaveBeenCalledOnce()
    })
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
    expect(readinessReads).toBe(2)
    expect(mocks.callTool).toHaveBeenCalledWith('edit_captions', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-4',
      action: 'enable',
      preset: 'netflix',
    }, { timeoutMs: 8_000 })
  })

  it('accepts an explicit word list from the structured project response for captions', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') return {
        timeline: {
          id: 'timeline-1',
          fps: 30,
          items: [{
            id: 'video-1',
            kind: 'video',
            src: '/media/uploads/current.mp4',
            startFrame: 0,
            durationInFrames: 360,
            words: [{ text: '你好', start: 0, end: 500 }],
          }],
        },
      }
      if (name === 'get_editor_url') return {
        editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
  })

  it('accepts the real read_project hasTranscript flag for captions', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'begin_edit_session') return { editSessionId: 'edit-session-1' }
      if (name === 'read_project') return {
        timeline: {
          id: 'timeline-1',
          fps: 30,
          items: [{
            id: 'video-1',
            kind: 'video',
            src: '/media/uploads/current.mp4',
            startFrame: 0,
            durationInFrames: 360,
            hasTranscript: true,
          }],
        },
      }
      if (name === 'get_editor_url') return {
        editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
      }
      return { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成字幕',
    })).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'needs_review' },
    })
  })

  it('discards the manual session when the caption operation fails', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const baseCallTool = mocks.callTool.getMockImplementation()
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'edit_captions') return { error: 'caption template failed' }
      return baseCallTool?.(name, args) ?? { ok: true }
    })

    await expect(runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '生成字幕',
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'tool_error',
        message: '专业剪辑器未能完成受控草案操作。',
        stage: 'draft_apply',
        toolCode: 'edit_captions',
      },
    })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', {
      editorProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    }, { timeoutMs: 8_000 })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('auto-imports only after MCP confirms an empty timeline and verifies with a new read', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'target_project') return { ok: true, projectId: args.projectId }
      if (name === 'openchatcut_status') return { connectedProjectIds: ['occ-project-1'] }
      if (name === 'begin_edit_session') return { editSessionId: `import-read-${reads + 1}` }
      if (name === 'read_project') {
        reads += 1
        return reads === 1
          ? { timeline: { id: 'timeline-1', fps: 30, items: [] } }
          : {
              timeline: {
                id: 'timeline-1',
                fps: 30,
                items: [{
                  id: 'video-1',
                  kind: 'video',
                  src: '/media/uploads/current.mp4',
                  durationInFrames: 360,
                }],
              },
            }
      }
      return { ok: true }
    })
    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })
    expect(result).toMatchObject({ status: 'ok', bridge: { phase: 'ready_to_draft' } })
    expect(mocks.importSource).toHaveBeenCalledWith(expect.objectContaining({
      cdpPort: 43210,
      timelineEmptyConfirmed: true,
    }))
    expect(mocks.connect).toHaveBeenCalledTimes(3)
  })

  it('uses discarded manual sessions for both import timeline reads required by the real MCP', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let sessionCount = 0
    let reads = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'target_project') return { ok: true, projectId: args.projectId }
      if (name === 'openchatcut_status') return { connectedProjectIds: ['occ-project-1'] }
      if (name === 'begin_edit_session') {
        sessionCount += 1
        return { editSessionId: `import-read-${sessionCount}` }
      }
      if (name === 'read_project') {
        if (!args.editSessionId) return { error: 'editSessionId is required' }
        reads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: reads === 1
              ? []
              : [{
                  id: 'video-1',
                  kind: 'video',
                  src: '/media/uploads/current.mp4',
                  durationInFrames: 360,
                }],
          },
        }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({ status: 'ok', bridge: { phase: 'ready_to_draft' } })
    expect(mocks.callTool.mock.calls.filter(([name]) => name === 'read_project').map(([, args]) => args))
      .toEqual([
        expect.objectContaining({ editorProjectId: 'occ-project-1', editSessionId: 'import-read-1' }),
        expect.objectContaining({ editorProjectId: 'occ-project-1', editSessionId: 'import-read-2' }),
      ])
    expect(mocks.callTool.mock.calls.filter(([name]) => name === 'discard_edit_session').map(([, args]) => args))
      .toEqual([
        { editorProjectId: 'occ-project-1', editSessionId: 'import-read-1' },
        { editorProjectId: 'occ-project-1', editSessionId: 'import-read-2' },
      ])
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('review_edit_session')
  })

  it('opens the target editor and waits for its structured connection before the first project read', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const events: string[] = []
    let statusReads = 0
    let projectReads = 0
    mocks.openEditor.mockImplementationOnce(async () => {
      events.push('open-editor')
      return { status: 'ok' }
    })
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      events.push(name)
      if (name === 'target_project') return { ok: true, projectId: args.projectId }
      if (name === 'openchatcut_status') {
        statusReads += 1
        return {
          connectedProjectIds: statusReads === 1 ? [] : ['occ-project-1'],
        }
      }
      if (name === 'begin_edit_session') return { editSessionId: `import-read-${projectReads + 1}` }
      if (name === 'read_project') {
        projectReads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: projectReads === 1
              ? []
              : [{
                  id: 'video-1',
                  kind: 'video',
                  src: '/media/uploads/current.mp4',
                  durationInFrames: 360,
                }],
          },
        }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({ status: 'ok', bridge: { phase: 'ready_to_draft' } })
    expect(events.indexOf('open-editor')).toBeGreaterThan(events.indexOf('target_project'))
    expect(events.indexOf('open-editor')).toBeLessThan(events.indexOf('openchatcut_status'))
    expect(events.lastIndexOf('openchatcut_status')).toBeLessThan(events.indexOf('read_project'))
  })

  it('rejects a malformed editor connection status before reading or uploading media', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ connectedProjectIds: 'occ-project-1' })
      .mockResolvedValueOnce({ connectedProjectIds: ['occ-project-1'] })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'editor_status_invalid' },
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('read_project')
    expect(mocks.importSource).not.toHaveBeenCalled()
  })

  it('times out a permanently pending editor status without reading or uploading media', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    const clock = new VirtualManagedWaitClock()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'openchatcut_status') return await new Promise<Record<string, unknown>>(() => undefined)
      return { ok: true }
    })

    const pending = runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    }, {
      editorConnectionClock: clock,
      editorConnectionTimeoutMs: 30,
      editorConnectionIntervalMs: 5,
    })
    await vi.waitFor(() => {
      expect(mocks.callTool.mock.calls.map(([name]) => name)).toContain('openchatcut_status')
    })
    await clock.advance(30)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'editor_connection_timeout' },
    })
    expect(mocks.callTool.mock.calls.map(([name]) => name)).not.toContain('read_project')
    expect(mocks.importSource).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  }, 1_000)

  it('does not enter ready_to_draft when the fresh MCP client targets a different project', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let targetCalls = 0
    let projectReads = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'target_project') {
        targetCalls += 1
        return {
          ok: true,
          projectId: targetCalls === 1 ? args.projectId : 'other-project',
        }
      }
      if (name === 'openchatcut_status') {
        return { connectedProjectIds: ['occ-project-1'] }
      }
      if (name === 'begin_edit_session') return { editSessionId: `import-read-${projectReads + 1}` }
      if (name === 'read_project') {
        projectReads += 1
        return {
          timeline: {
            id: 'timeline-1',
            fps: 30,
            items: projectReads === 1
              ? []
              : [{
                  id: 'video-1',
                  kind: 'video',
                  src: '/media/uploads/current.mp4',
                  durationInFrames: 360,
                }],
          },
        }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'project_identity_mismatch' },
    })
    const bridge = await readBridgeFile()
    expect(bridge.phase).toBe('needs_user_import')
    expect(mocks.importSource).toHaveBeenCalledTimes(1)
  })

  it('never uploads when the connected project timeline is not empty', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'target_project') return { ok: true, projectId: args.projectId }
      if (name === 'openchatcut_status') return { connectedProjectIds: ['occ-project-1'] }
      if (name === 'begin_edit_session') return { editSessionId: 'import-read-1' }
      if (name === 'read_project') {
        return {
          timeline: {
            id: 'timeline-1',
            items: [{ id: 'existing-video', kind: 'video' }],
          },
        }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'timeline_not_empty' },
    })
    expect(mocks.importSource).not.toHaveBeenCalled()
  })

  it('keeps needs_user_import when the fresh MCP verification read fails', async () => {
    await createBridge()
    mocks.callTool.mockClear()
    let projectReads = 0
    mocks.callTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'target_project') return { ok: true, projectId: args.projectId }
      if (name === 'openchatcut_status') return { connectedProjectIds: ['occ-project-1'] }
      if (name === 'begin_edit_session') return { editSessionId: `import-read-${projectReads + 1}` }
      if (name === 'read_project') {
        projectReads += 1
        return projectReads === 1
          ? { timeline: { id: 'timeline-1', items: [] } }
          : { error: 'fresh verification failed' }
      }
      return { ok: true }
    })

    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'import',
      openChatCutProjectId: 'occ-project-1',
    })

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'tool_error' },
    })
    expect((await readBridgeFile()).phase).toBe('needs_user_import')
    expect(mocks.importSource).toHaveBeenCalledTimes(1)
  })

  it('fails the project edit operation and never completes it when export fails', async () => {
    await createBridge()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'get_edit_session') return { status: 'applied' }
      if (name === 'get_editor_url') return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      return { ok: true }
    })
    await runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
    mocks.exportVideo.mockRejectedValueOnce(new Error('download failed'))
    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'export',
      openChatCutProjectId: 'occ-project-1',
    })
    expect(result).toMatchObject({ status: 'error' })
    expect(mocks.failStage).toHaveBeenCalled()
    expect(mocks.completeStage).not.toHaveBeenCalled()
    expect(mocks.savePostArtifact).not.toHaveBeenCalled()
  })

  it('recovers the bridge when project.json is already ready for the exact export operation', async () => {
    await createBridge()
    await writeExportingBridge(
      'openchatcut-recovery-1',
      'openchatcut-export-recovery-1',
      60,
    )
    matchingEditStage('ready')
    await writeRecoveredVideo()
    mocks.probeExport.mockResolvedValue({ codec: 'h264', durationSeconds: 15 })
    mocks.getPostArtifact.mockResolvedValueOnce({
      artifactId: 'openchatcut-recovery-1',
      status: 'ready',
      source: 'openchatcut',
      sessionId: 'openchatcut-export-recovery-1',
      renderArtifactId: 'render-1',
      scriptArtifactId: 'script-1',
      durationSeconds: 15,
      outputPath: path.join(root, 'artifacts', 'post-production', 'openchatcut-recovery-1.mp4'),
      parameters: { plan: createDefaultEditPlan(), request: '专业精剪' },
    })

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'exported',
        exportedArtifactId: 'openchatcut-recovery-1',
      },
    })
    expect(mocks.completeStage).not.toHaveBeenCalled()
    expect((await readBridgeFile()).version).toBe(4)
  })

  it('reconciles a complete artifact left behind by an interrupted running export', async () => {
    await createBridge()
    await writeExportingBridge()
    matchingEditStage('running')
    await writeRecoveredVideo()

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'exported' },
    })
    expect(mocks.reconcileStage).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({
        status: 'ready',
        operationId: 'openchatcut-recovery-1',
        sessionId: 'openchatcut-export-recovery-1',
      }),
    }))
  })

  it('rebuilds the artifact record from the exact complete MP4 before reconciling ready', async () => {
    await createBridge()
    await writeExportingBridge(
      'openchatcut-recovery-1',
      'openchatcut-export-recovery-1',
      60,
    )
    matchingEditStage('running')
    await writeRecoveredVideo()
    mocks.probeExport.mockResolvedValue({ codec: 'h264', durationSeconds: 15 })
    mocks.getPostArtifact
      .mockRejectedValueOnce(new Error('artifact missing'))
      .mockImplementation(async (_workspace: unknown, artifactId: string) => ({
        artifactId,
        status: 'ready',
        source: 'openchatcut',
        sessionId: 'openchatcut-export-recovery-1',
        renderArtifactId: 'render-1',
        scriptArtifactId: 'script-1',
        durationSeconds: 15,
        outputPath: path.join(root, 'artifacts', 'post-production', `${artifactId}.mp4`),
        parameters: { plan: createDefaultEditPlan(), request: '专业精剪' },
      }))

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'exported' },
    })
    expect(mocks.savePostArtifact).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'openchatcut-recovery-1',
      sessionId: 'openchatcut-export-recovery-1',
      source: 'openchatcut',
      durationSeconds: 15,
    }))
  })

  it('rejects a mismatched artifact duration without rebuilding it from the MP4', async () => {
    await createBridge()
    await writeExportingBridge(
      'openchatcut-recovery-1',
      'openchatcut-export-recovery-1',
      60,
    )
    matchingEditStage('running')
    await writeRecoveredVideo()
    mocks.probeExport.mockResolvedValue({ codec: 'h264', durationSeconds: 16 })
    mocks.getPostArtifact.mockResolvedValueOnce({
      artifactId: 'openchatcut-recovery-1',
      status: 'ready',
      source: 'openchatcut',
      sessionId: 'openchatcut-export-recovery-1',
      renderArtifactId: 'render-1',
      scriptArtifactId: 'script-1',
      durationSeconds: 15,
      outputPath: path.join(root, 'artifacts', 'post-production', 'openchatcut-recovery-1.mp4'),
      parameters: { plan: createDefaultEditPlan(), request: '专业精剪' },
    })

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'applied' },
    })
    expect(mocks.savePostArtifact).not.toHaveBeenCalled()
    expect(mocks.failStage).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'openchatcut-recovery-1',
      error: expect.objectContaining({ code: 'export_interrupted' }),
    }))
  })

  it('fails only the matching interrupted operation and returns the bridge to applied', async () => {
    await createBridge()
    await writeExportingBridge()
    matchingEditStage('running')

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'applied' },
    })
    expect(mocks.failStage).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'openchatcut-recovery-1',
      error: expect.objectContaining({ code: 'export_interrupted' }),
    }))
    expect(await readBridgeFile()).not.toHaveProperty('exportOperationId')
  })

  it('does not overwrite a different edit operation while reconciling an old export', async () => {
    await createBridge()
    await writeExportingBridge()
    matchingEditStage('running', 'openchatcut-other-operation', 'openchatcut-other-session')

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      stale: true,
      detail: expect.stringContaining('其他任务'),
    })
    expect(mocks.failStage).not.toHaveBeenCalled()
    expect((await readBridgeFile()).phase).toBe('exporting')
  })

  it('deduplicates concurrent export POSTs and never starts a second CDP export', async () => {
    await createBridge()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'get_edit_session') return { status: 'applied' }
      if (name === 'get_editor_url') return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      return { ok: true }
    })
    await runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
    let release!: (value: { status: 'ok'; outputPath: string; durationSeconds: number }) => void
    mocks.exportVideo.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = runOpenChatCutSession({
      projectId: 'demo',
      action: 'export',
      openChatCutProjectId: 'occ-project-1',
    })
    const second = runOpenChatCutSession({
      projectId: 'demo',
      action: 'export',
      openChatCutProjectId: 'occ-project-1',
    })
    await vi.waitFor(() => expect(mocks.exportVideo).toHaveBeenCalledTimes(1))
    release({
      status: 'ok',
      outputPath: path.join(root, 'artifacts', 'post-production', 'concurrent.mp4'),
      durationSeconds: 12,
    })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ok' }),
      expect.objectContaining({ status: 'ok' }),
    ])
    expect(mocks.exportVideo).toHaveBeenCalledTimes(1)
  })

  it('migrates v3 exporting only from an exact current stage identity', async () => {
    await createBridge()
    const legacy = await readBridgeFile()
    delete legacy.exportOperationId
    delete legacy.exportSessionId
    legacy.version = 3
    legacy.phase = 'exporting'
    await fs.writeFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
      `${JSON.stringify(legacy)}\n`,
    )
    matchingEditStage('ready')
    await writeRecoveredVideo()

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'exported', exportedArtifactId: 'openchatcut-recovery-1' },
    })
    await expect(readBridgeFile()).resolves.toMatchObject({
      version: 4,
      exportOperationId: 'openchatcut-recovery-1',
      exportSessionId: 'openchatcut-export-recovery-1',
    })
  })

  it('downgrades an unverifiable v3 exporting bridge to applied without touching another operation', async () => {
    await createBridge()
    const legacy = await readBridgeFile()
    legacy.version = 3
    legacy.phase = 'exporting'
    await fs.writeFile(
      path.join(mocks.workspace.contextPath, 'openchatcut-bridge.json'),
      `${JSON.stringify(legacy)}\n`,
    )
    matchingEditStage('running', 'openchatcut-other-operation', 'openchatcut-other-session')
    mocks.projectState.stages.edit.operation.upstreamArtifactId = 'render-other'

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'applied' },
    })
    await expect(readBridgeFile()).resolves.toMatchObject({ version: 4, phase: 'applied' })
    expect(mocks.failStage).not.toHaveBeenCalled()
  })

  it('returns a matching durable failed export to applied without failing it twice', async () => {
    await createBridge()
    await writeExportingBridge()
    matchingEditStage('failed')

    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { phase: 'applied' },
    })
    expect(mocks.failStage).not.toHaveBeenCalled()
    await expect(readBridgeFile()).resolves.not.toHaveProperty('exportOperationId')
  })

  it('restores an exported bridge against its own current edit artifact without marking it stale', async () => {
    await createBridge()
    mocks.callTool.mockImplementation(async (name: string) => {
      if (name === 'get_edit_session') return { status: 'applied' }
      if (name === 'get_editor_url') return { editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1' }
      return { ok: true }
    })
    await runOpenChatCutSession({
      projectId: 'demo',
      action: 'status',
      openChatCutProjectId: 'occ-project-1',
      editSessionId: 'edit-session-1',
    })
    const exported = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'export',
      openChatCutProjectId: 'occ-project-1',
    })
    expect(exported).toMatchObject({ status: 'ok', bridge: { phase: 'exported' } })
    if (exported.status !== 'ok' || !exported.bridge.exportedArtifactId) throw new Error('missing exported artifact')
    mocks.projectState.stages.edit = {
      status: 'ready',
      artifactId: exported.bridge.exportedArtifactId,
      source: 'openchatcut',
    }
    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: {
        phase: 'exported',
        exportedArtifactId: exported.bridge.exportedArtifactId,
      },
    })
  })

  it('discards the session when AI planning fails', async () => {
    await createBridge()
    mocks.generatePlan.mockResolvedValueOnce({
      status: 'agent_error',
      source: 'ai_edit_plan_agent',
      error: { code: 'ai_failed', message: 'AI failed' },
    })
    const result = await runOpenChatCutSession({
      projectId: 'demo',
      action: 'begin',
      openChatCutProjectId: 'occ-project-1',
      request: '增强开场节奏',
    })
    expect(result).toMatchObject({ status: 'error', error: { code: 'ai_failed' } })
    expect(mocks.callTool).toHaveBeenCalledWith('discard_edit_session', expect.any(Object))
  })

  it('restores only a bridge matching the current source and script lineage', async () => {
    await createBridge()
    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      bridge: { sourceArtifactId: 'render-1', scriptArtifactId: 'script-1' },
    })
    mocks.projectState.stages.digitalHuman.artifactId = 'render-2'
    await expect(getOpenChatCutProject('demo')).resolves.toMatchObject({
      status: 'ok',
      stale: true,
    })
  })

  it('uses elapsed monotonic time and reaches MCP without leaking its deadline timer', async () => {
    const clock = new VirtualManagedWaitClock()
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        phase: 'installed' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'installed',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'launching' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'launching',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'mcp_ready' as const,
        installed: true,
        installerReady: false,
        mcpReady: true,
        detail: 'ready',
        version: '0.1.6',
      })
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 25,
      intervalMs: 10,
    })
    await clock.flush()
    await clock.advance(10)
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({ mcpReady: true })
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(clock.timerCount).toBe(0)
  })

  it('uses the exact default 45-second elapsed-time budget without treating initial installed as terminal', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'process has not opened its window yet',
      version: '0.1.6',
    }
    const inspect = vi.fn(async () => installed)
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
    })
    await clock.flush()
    await clock.advance(45_000)

    await expect(pending).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledTimes(60)
    expect(clock.now()).toBe(45_000)
    expect(clock.timerCount).toBe(0)
  })

  it('times out when the first inspection stays permanently pending', async () => {
    const clock = new VirtualManagedWaitClock()
    const inspect = vi.fn(() => new Promise<never>(() => undefined))
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 20,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(20)

    await expect(pending).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(clock.timerCount).toBe(0)
  })

  it('observes a rejection arriving after the deadline without surfacing an unhandled rejection', async () => {
    const clock = new VirtualManagedWaitClock()
    let rejectInspection!: (reason: unknown) => void
    const inspect = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectInspection = reject
    }))
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 10,
    })
    await clock.flush()
    await clock.advance(10)
    await expect(pending).resolves.toBeUndefined()

    rejectInspection(new Error('late inspection failure'))
    await clock.flush()
    expect(clock.timerCount).toBe(0)
  })

  it('caps the final sleep to the remaining budget and starts no inspection at the deadline', async () => {
    const clock = new VirtualManagedWaitClock()
    const inspect = vi.fn(async () => ({
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }))
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 10,
      intervalMs: 100,
    })
    await clock.flush()
    expect(clock.scheduledDelays).toEqual([10, 10])
    await clock.advance(10)

    await expect(pending).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(clock.timerCount).toBe(0)
  })

  it('rejects a ready inspection that completed after the shared deadline', async () => {
    const clock = new VirtualManagedWaitClock()
    const inspect = vi.fn()
      .mockImplementationOnce(async () => {
        clock.jump(5)
        return {
          phase: 'installed' as const,
          installed: true,
          installerReady: false,
          mcpReady: false,
          detail: 'installed',
          version: '0.1.6',
        }
      })
      .mockImplementationOnce(async () => {
        clock.jump(5)
        return {
          phase: 'mcp_ready' as const,
          installed: true,
          installerReady: false,
          mcpReady: true,
          detail: 'late ready',
          version: '0.1.6',
        }
      })
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 10,
      intervalMs: 2,
    })
    await clock.flush()
    await clock.advance(2)

    await expect(pending).resolves.toBeUndefined()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(clock.now()).toBe(12)
    expect(clock.timerCount).toBe(0)
  })

  it('returns immediately when an explicit terminal MCP state appears', async () => {
    const clock = new VirtualManagedWaitClock()
    const terminal = {
      phase: 'failed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'token mismatch',
      version: '0.1.6',
      error: { code: 'auth_error', message: 'token mismatch' },
    }
    const inspect = vi.fn(async () => terminal)

    await expect(waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 45_000,
      intervalMs: 1_000,
    })).resolves.toEqual(terminal)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(clock.timerCount).toBe(0)
  })

  it('returns installed as closed only after observing a managed launching phase', async () => {
    const clock = new VirtualManagedWaitClock()
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        phase: 'launching' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'window visible',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'installed' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'window closed',
        version: '0.1.6',
      })
    const pending = waitForOpenChatCutMcp({
      inspect,
      clock,
      timeoutMs: 45_000,
      intervalMs: 1_000,
    })
    await clock.flush()
    await clock.advance(1_000)

    await expect(pending).resolves.toMatchObject({ phase: 'installed' })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(clock.timerCount).toBe(0)
  })

  it('bounds the initial managed inspection before deciding whether to launch', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const inspect = vi.fn(() => new Promise<never>(() => undefined))
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 10,
    })
    await clock.flush()
    await clock.advance(10)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'mcp_start_timeout' },
    })
    expect(launch).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  })

  it('normalizes a synchronous initial inspection failure and releases its deadline timer', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const inspect = vi.fn(() => {
      throw new Error('synchronous inspect failure')
    })

    await expect(launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 10,
    })).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'runtime_inspection_failed',
        message: expect.stringContaining('synchronous inspect failure'),
      },
    })
    expect(launch).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  })

  it('does not accept MCP readiness when launch consumes the entire shared budget', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValue({
        ...installed,
        phase: 'mcp_ready' as const,
        mcpReady: true,
        detail: 'ready',
      })
    const launch = vi.fn(async () => {
      clock.jump(10)
      return { status: 'ok' as const, source: 'openchatcut' as const }
    })

    await expect(launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 10,
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'mcp_start_timeout' },
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(clock.timerCount).toBe(0)
  })

  it('keeps initial installed non-terminal during a managed cold start', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({
        ...installed,
        phase: 'launching' as const,
        detail: 'window visible',
      })
      .mockResolvedValueOnce({
        ...installed,
        phase: 'mcp_ready' as const,
        mcpReady: true,
        detail: 'ready',
      })
    const launch = vi.fn(async () => ({ status: 'ok' as const, source: 'openchatcut' as const }))
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 30,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(5)
    await clock.advance(5)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      runtime: { phase: 'mcp_ready' },
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(4)
    expect(clock.timerCount).toBe(0)
  })

  it('single-flights concurrent managed app launches', async () => {
    const clock = new VirtualManagedWaitClock()
    let release: (() => void) | undefined
    const launched = new Promise<void>((resolve) => { release = resolve })
    const launch = vi.fn(async () => {
      await launched
      return { status: 'ok' as const, source: 'openchatcut' as const }
    })
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        phase: 'installed', installed: true, installerReady: false, mcpReady: false, detail: 'installed', version: '0.1.6',
      })
      .mockResolvedValue({
        phase: 'mcp_ready', installed: true, installerReady: false, mcpReady: true, detail: 'ready', version: '0.1.6',
      })

    const first = launchOpenChatCutRuntime('app', { launch, inspect, clock })
    const second = launchOpenChatCutRuntime('app', { launch, inspect, clock })
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    release?.()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'ok', runtime: { phase: 'mcp_ready' } },
      { status: 'ok', runtime: { phase: 'mcp_ready' } },
    ])
    expect(clock.timerCount).toBe(0)
  })

  it('does not spawn when MCP belongs to an unverifiable external instance', async () => {
    const launch = vi.fn()
    const inspect = vi.fn(async () => ({
      phase: 'external_instance' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'external',
      version: '0.1.6',
      error: { code: 'external_instance', message: 'external' },
    }))
    await expect(launchOpenChatCutRuntime('app', { launch, inspect })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'external_instance' },
    })
    expect(launch).not.toHaveBeenCalled()
  })

  it('keeps polling a transient external snapshot after spawn until the managed page and MCP are ready', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({
        ...installed,
        phase: 'external_instance' as const,
        detail: 'MCP ready before managed CDP page',
        error: { code: 'external_instance', message: 'identity pending' },
      })
      .mockResolvedValueOnce({
        ...installed,
        phase: 'launching' as const,
        detail: 'managed page visible',
      })
      .mockResolvedValueOnce({
        ...installed,
        phase: 'mcp_ready' as const,
        mcpReady: true,
        detail: 'ready',
      })
    const launch = vi.fn(async () => ({ status: 'ok' as const, source: 'openchatcut' as const }))
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 20,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(5)
    await clock.advance(5)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      runtime: { phase: 'mcp_ready' },
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(4)
    expect(clock.timerCount).toBe(0)
  })

  it('keeps polling a transient external snapshot after an existing managed launching phase', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const launching = {
      phase: 'launching' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'managed page visible',
      version: '0.1.6',
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(launching)
      .mockResolvedValueOnce({
        ...launching,
        phase: 'external_instance' as const,
        detail: 'MCP identity temporarily ahead of CDP',
        error: { code: 'external_instance', message: 'identity pending' },
      })
      .mockResolvedValueOnce({
        ...launching,
        phase: 'mcp_ready' as const,
        mcpReady: true,
        detail: 'ready',
      })
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 10,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(5)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      runtime: { phase: 'mcp_ready' },
    })
    expect(launch).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(clock.timerCount).toBe(0)
  })

  it('returns a stable dedicated external-instance error when the post-spawn mismatch persists to the deadline', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }
    const persistentExternal = {
      ...installed,
      phase: 'external_instance' as const,
      detail: 'MCP has no matching managed CDP page',
      error: { code: 'external_instance', message: 'identity mismatch' },
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValue(persistentExternal)
    const launch = vi.fn(async () => ({ status: 'ok' as const, source: 'openchatcut' as const }))
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 12,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(12)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'external_instance',
        message: expect.stringContaining('始终无法与受管窗口身份匹配'),
      },
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(4)
    expect(clock.timerCount).toBe(0)
  })

  it('stops immediately on auth failure after a transient post-spawn external snapshot', async () => {
    const clock = new VirtualManagedWaitClock()
    const installed = {
      phase: 'installed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'installed',
      version: '0.1.6',
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce({
        ...installed,
        phase: 'external_instance' as const,
        detail: 'identity pending',
        error: { code: 'external_instance', message: 'identity pending' },
      })
      .mockResolvedValueOnce({
        ...installed,
        phase: 'failed' as const,
        detail: 'token mismatch',
        error: { code: 'auth_error', message: 'token mismatch' },
      })
    const launch = vi.fn(async () => ({ status: 'ok' as const, source: 'openchatcut' as const }))
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 45_000,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(5)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'auth_error', message: 'token mismatch' },
    })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(clock.now()).toBe(5)
    expect(clock.timerCount).toBe(0)
  })

  it('waits for MCP on an existing managed window without spawning another app', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        phase: 'launching',
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'window ready',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'launching',
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'waiting mcp',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'mcp_ready',
        installed: true,
        installerReady: false,
        mcpReady: true,
        detail: 'ready',
        version: '0.1.6',
      })

    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 20,
      intervalMs: 5,
    })
    await clock.flush()
    await clock.advance(5)

    await expect(pending).resolves.toMatchObject({
      status: 'ok',
      runtime: { phase: 'mcp_ready' },
    })
    expect(launch).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  })

  it('returns the terminal managed runtime error after a bounded MCP wait', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const launching = {
      phase: 'launching' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'waiting mcp',
      version: '0.1.6',
    }
    const terminal = {
      phase: 'failed' as const,
      installed: true,
      installerReady: false,
      mcpReady: false,
      detail: 'token mismatch',
      version: '0.1.6',
      error: { code: 'auth_error', message: 'token mismatch' },
    }
    const inspect = vi.fn()
      .mockResolvedValueOnce(launching)
      .mockResolvedValueOnce(launching)
      .mockResolvedValue(terminal)

    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 10,
      intervalMs: 1,
    })
    await clock.flush()
    await clock.advance(1)
    await clock.advance(1)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'auth_error', message: 'token mismatch' },
    })
    expect(launch).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  })

  it('classifies a managed window closing without waiting for the full MCP timeout', async () => {
    const clock = new VirtualManagedWaitClock()
    const launch = vi.fn()
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        phase: 'launching' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'window ready',
        version: '0.1.6',
      })
      .mockResolvedValueOnce({
        phase: 'installed' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: 'window closed',
        version: '0.1.6',
      })
    const pending = launchOpenChatCutRuntime('app', {
      launch,
      inspect,
      clock,
      timeoutMs: 45_000,
      intervalMs: 1_000,
    })
    await clock.flush()
    await clock.advance(1_000)

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: { code: 'managed_window_closed' },
    })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(launch).not.toHaveBeenCalled()
    expect(clock.timerCount).toBe(0)
  })
})
