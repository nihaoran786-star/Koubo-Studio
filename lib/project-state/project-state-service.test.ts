import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { emptyScript } from '@/lib/workspace'
import {
  applyMutation,
  approveProjectScriptArtifact,
  beginProjectStageOperation,
  completeProjectStageOperation,
  createProjectState,
  failProjectStageOperation,
  getProjectState,
  listProjectStates,
  markProjectStageOperationRunning,
  mutateProjectState,
  reconcileProjectStageOperation,
} from './project-state-service'

const ids = new Set<string>()
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...ids].map((id) => fs.rm(path.join(getWorkspacesRoot(), id), { recursive: true, force: true })))
  ids.clear()
})

function id(label: string) { const value = `project-state-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`; ids.add(value); return value }

describe('project.json state service', () => {
  it('allows both local ffmpeg and OpenChatCut as edit-stage sources', async () => {
    const projectId = id('edit-sources')
    await createProjectState({
      projectId,
      script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' },
    })
    await expect(beginProjectStageOperation({
      projectId,
      stage: 'edit',
      operationId: 'openchatcut-edit',
      sessionId: 'openchatcut-session',
      source: 'openchatcut',
      expectedUpstreamArtifactId: 'render-001',
    })).rejects.toMatchObject({ code: 'stage_prerequisite_not_ready' })
    await expect(beginProjectStageOperation({
      projectId,
      stage: 'edit',
      operationId: 'invalid-edit',
      sessionId: 'invalid-session',
      source: 'heygem',
      expectedUpstreamArtifactId: 'render-001',
    })).rejects.toMatchObject({ code: 'stage_source_mismatch' })
  })

  it('commits an approved script artifact atomically and idempotently, then opens the voice gate', async () => {
    const projectId = id('approve-script')
    const created = await createProjectState({ projectId, script: emptyScript() })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveScriptArtifact({
      workspace,
      artifactId: 'script-approved',
      sessionId: 'script-session',
      approvalStatus: 'approved',
      content: {
        title: '确认后的文案', hook: '开场', body: '这是已确认正文', caption: '说明', tags: ['口播'],
        durationSeconds: 30, voiceNotes: '自然', shotNotes: '正面', riskNotes: '',
      },
      now: '2026-07-16T00:01:00.000Z',
    })

    const approved = await approveProjectScriptArtifact({
      projectId,
      artifactId: 'script-approved',
      now: '2026-07-16T00:02:00.000Z',
    })
    expect(approved).toMatchObject({
      revision: created.revision + 1,
      script: { artifactId: 'script-approved', approvalStatus: 'approved', body: '这是已确认正文' },
      stages: { script: { status: 'ready', artifactId: 'script-approved' }, voice: { status: 'needs_input' } },
    })
    await expect(approveProjectScriptArtifact({ projectId, artifactId: 'script-approved' })).resolves.toEqual(approved)
    await expect(beginProjectStageOperation({
      projectId,
      stage: 'voice',
      operationId: 'audio-after-approval',
      sessionId: 'voice-session',
      source: 'indextts2',
      expectedUpstreamArtifactId: 'script-approved',
    })).resolves.toMatchObject({ stages: { voice: { status: 'queued' } } })
  })

  it('does not accept draft artifacts or a mismatched script id as the voice predecessor', async () => {
    const projectId = id('script-gate')
    await createProjectState({ projectId, script: emptyScript() })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveScriptArtifact({
      workspace,
      artifactId: 'script-draft',
      sessionId: 'script-session',
      approvalStatus: 'draft',
      content: { title: '草稿', hook: '', body: '正文', caption: '', tags: [], durationSeconds: 30, voiceNotes: '', shotNotes: '', riskNotes: '' },
    })
    await expect(approveProjectScriptArtifact({ projectId, artifactId: 'script-draft' })).rejects.toMatchObject({ code: 'script_artifact_not_approved' })
    await expect(beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-1', sessionId: 'voice-1', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-other',
    })).rejects.toMatchObject({ code: 'stage_prerequisite_not_ready' })
    await saveScriptArtifact({
      workspace,
      artifactId: 'script-approved',
      sessionId: 'script-session',
      approvalStatus: 'approved',
      content: { title: '确认稿', hook: '', body: '正文', caption: '', tags: [], durationSeconds: 30, voiceNotes: '', shotNotes: '', riskNotes: '' },
    })
    await approveProjectScriptArtifact({ projectId, artifactId: 'script-approved' })
    await expect(beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-2', sessionId: 'voice-2', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-other',
    })).rejects.toMatchObject({ code: 'stage_upstream_mismatch' })
  })
  it('creates, reads and lists only workspaces with a valid project.json', async () => {
    const projectId = id('create')
    const ignoredId = id('ignored')
    await ensureProjectWorkspace(ignoredId, 'digital-human')
    const created = await createProjectState({ projectId, script: emptyScript(), now: '2026-07-16T00:00:00.000Z' })
    expect(created).toMatchObject({ version: 1, revision: 1, projectId, currentStep: 'idea', furthestStep: 'idea' })
    await expect(getProjectState(projectId)).resolves.toEqual(created)
    const listed = await listProjectStates()
    expect(listed.projects.find((project) => project.projectId === projectId)).toEqual(created)
    expect(listed.projects.find((project) => project.projectId === ignoredId)).toBeUndefined()
    expect(listed.issues).toEqual([])
  })

  it('keeps valid projects visible when one project.json is corrupted', async () => {
    const validId = id('valid')
    const corruptId = id('corrupt')
    const valid = await createProjectState({ projectId: validId, script: emptyScript() })
    const corruptWorkspace = await ensureProjectWorkspace(corruptId, 'digital-human')
    await fs.writeFile(path.join(corruptWorkspace.rootPath, 'project.json'), '{broken json', 'utf8')

    const listed = await listProjectStates()

    expect(listed.projects).toContainEqual(valid)
    expect(listed.issues).toContainEqual({
      projectId: corruptId,
      code: 'invalid_project_state',
      message: '项目数据已损坏，暂时无法打开。',
    })
  })

  it('invalidates every downstream artifact when approved script content changes', async () => {
    const project = await createProjectState({ projectId: id('cascade'), script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '旧文案' } })
    const seeded = {
      ...project,
      stages: {
        script: { status: 'ready' as const, artifactId: 'script-001', updatedAt: project.updatedAt },
        voice: { status: 'ready' as const, artifactId: 'audio-001', updatedAt: project.updatedAt },
        digitalHuman: { status: 'ready' as const, artifactId: 'render-001', updatedAt: project.updatedAt },
        edit: { status: 'ready' as const, artifactId: 'post-001', updatedAt: project.updatedAt },
        publish: { status: 'ready' as const, artifactId: 'publish-001', updatedAt: project.updatedAt },
      },
    }
    const next = applyMutation(seeded, { operation: 'update_script', script: { ...seeded.script, artifactId: 'script-002', body: '新文案' } }, '2026-07-16T01:00:00.000Z')
    expect(next.revision).toBe(2)
    expect(next.stages.voice).toMatchObject({ status: 'needs_input' })
    expect(next.stages.voice.artifactId).toBeUndefined()
    expect(next.stages.digitalHuman.status).toBe('idle')
    expect(next.stages.edit.status).toBe('idle')
    expect(next.stages.publish.status).toBe('idle')
  })

  it('gates forward navigation, allows backward navigation and preserves the furthest step', async () => {
    const projectId = id('revision')
    const created = await createProjectState({
      projectId,
      script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' },
    })
    const atVoice = await mutateProjectState(projectId, { operation: 'set_current_step', step: 'voice', expectedRevision: created.revision })
    const back = await mutateProjectState(projectId, { operation: 'set_current_step', step: 'idea', expectedRevision: atVoice.revision })
    expect(back).toMatchObject({ currentStep: 'idea', furthestStep: 'voice', revision: 3 })
    await expect(mutateProjectState(projectId, { operation: 'set_current_step', step: 'avatar', expectedRevision: back.revision })).rejects.toMatchObject({ code: 'stage_prerequisite_not_ready' })
    await expect(mutateProjectState(projectId, { operation: 'set_current_step', step: 'publish', expectedRevision: 1 })).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('accepts only a ready audio artifact linked to the current script', async () => {
    const projectId = id('audio')
    const script = { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved' as const, body: '正文' }
    const project = await createProjectState({ projectId, script })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-001', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await saveAudioArtifact({
      workspace, artifactId: 'audio-other-session', sessionId: 'voice-other', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-other-session.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await saveAudioArtifact({
      workspace, artifactId: 'audio-foreign', sessionId: 'voice-foreign', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-foreign.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-foreign', text: '其他正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    const selected = await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-001', expectedRevision: project.revision })
    expect(selected.stages.voice).toMatchObject({ status: 'ready', artifactId: 'audio-001' })
    expect(selected.stages.digitalHuman.status).toBe('needs_input')
    const repeated = await mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-001', expectedRevision: project.revision })
    expect(repeated).toEqual(selected)
    await expect(mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-foreign', expectedRevision: selected.revision })).rejects.toMatchObject({ code: 'audio_script_mismatch' })
    await expect(mutateProjectState(projectId, { operation: 'select_artifact', stage: 'voice', artifactId: 'audio-missing', expectedRevision: selected.revision })).rejects.toMatchObject({ code: 'invalid_audio_artifact' })
  })

  it('serializes concurrent writes so exactly one mutation with the same revision wins', async () => {
    const projectId = id('concurrent')
    const created = await createProjectState({ projectId, script: emptyScript() })
    const results = await Promise.allSettled([
      mutateProjectState(projectId, {
        operation: 'update_script',
        script: { ...created.script, title: '并发版本 A' },
        expectedRevision: created.revision,
      }),
      mutateProjectState(projectId, {
        operation: 'update_script',
        script: { ...created.script, title: '并发版本 B' },
        expectedRevision: created.revision,
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toMatchObject({ code: 'revision_conflict' })
    expect((await getProjectState(projectId)).revision).toBe(created.revision + 1)
  })

  it('runs a stage operation through queued, running and ready with operation CAS', async () => {
    const projectId = id('operation-ready')
    const script = { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved' as const, body: '正文' }
    await createProjectState({ projectId, script, now: '2026-07-16T00:00:00.000Z' })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-001', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await saveAudioArtifact({
      workspace, artifactId: 'audio-other-session', sessionId: 'voice-other', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-other-session.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })

    const queued = await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-16T00:01:00.000Z',
    })
    expect(queued.stages.voice).toMatchObject({
      status: 'queued', source: 'indextts2', operation: { id: 'audio-001', sessionId: 'voice-001', upstreamArtifactId: 'script-001' },
    })
    await expect(getProjectState(projectId)).resolves.toEqual(queued)
    const repeated = await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-16T00:01:30.000Z',
    })
    expect(repeated).toEqual(queued)
    await expect(beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-conflict', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001',
    })).rejects.toMatchObject({ code: 'stage_operation_conflict' })
    const running = await markProjectStageOperationRunning({
      projectId, stage: 'voice', operationId: 'audio-001', now: '2026-07-16T00:02:00.000Z',
    })
    expect(running.stages.voice.status).toBe('running')
    await expect(completeProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', artifactId: 'audio-other-session',
    })).rejects.toMatchObject({ code: 'stage_artifact_session_mismatch' })
    const ready = await completeProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', artifactId: 'audio-001', now: '2026-07-16T00:03:00.000Z',
    })
    expect(ready.stages.voice).toEqual({
      status: 'ready', artifactId: 'audio-001', source: 'indextts2',
      operation: {
        id: 'audio-001', sessionId: 'voice-001', upstreamArtifactId: 'script-001', startedAt: '2026-07-16T00:01:00.000Z',
      },
      updatedAt: '2026-07-16T00:03:00.000Z',
    })
    expect(ready.stages.digitalHuman.status).toBe('needs_input')
    await expect(failProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', error: { code: 'late_failure', message: '迟到失败' },
    })).rejects.toMatchObject({ code: 'stage_operation_stale' })
    await expect(completeProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-old', artifactId: 'audio-old',
    })).rejects.toMatchObject({ code: 'stage_operation_stale' })
  })

  it('rejects a second active operation and prevents a superseded operation from changing state', async () => {
    const projectId = id('operation-stale')
    const script = { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved' as const, body: '旧正文' }
    const created = await createProjectState({ projectId, script })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-old', sessionId: 'voice-old', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })
    await expect(beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-new', sessionId: 'voice-new', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })).rejects.toMatchObject({ code: 'stage_operation_in_progress' })

    const current = await getProjectState(projectId)
    await mutateProjectState(projectId, {
      operation: 'update_script',
      script: { ...script, artifactId: 'script-002', body: '新正文' },
      expectedRevision: current.revision,
    })
    await expect(failProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-old', error: { code: 'runtime_failed', message: '旧任务失败' },
    })).rejects.toMatchObject({ code: 'stage_operation_stale' })
    expect((await getProjectState(projectId)).stages.voice).toMatchObject({ status: 'needs_input' })
    expect((await getProjectState(projectId)).revision).toBe(created.revision + 2)
  })

  it('records a matching active operation failure without retaining an artifact', async () => {
    const projectId = id('operation-failed')
    await createProjectState({
      projectId,
      script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' },
    })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-failed', sessionId: 'voice-failed', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })
    const failed = await failProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-failed', error: { code: 'runtime_failed', message: '运行失败' },
    })
    expect(failed.stages.voice).toMatchObject({
      status: 'failed', source: 'indextts2', operation: { id: 'audio-failed' }, error: { code: 'runtime_failed', message: '运行失败' },
    })
    expect(failed.stages.voice.artifactId).toBeUndefined()
  })

  it('reconciles a ready voice task after a crash and keeps repeated reads revision-idempotent', async () => {
    const projectId = id('reconcile-ready')
    await createProjectState({
      projectId,
      script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' },
    })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-001', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-17T00:00:00.000Z',
    })
    await markProjectStageOperationRunning({ projectId, stage: 'voice', operationId: 'audio-001' })

    const reconciled = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-001' },
      now: '2026-07-17T00:05:00.000Z',
    })
    expect(reconciled.stages.voice).toMatchObject({ status: 'ready', artifactId: 'audio-001', source: 'indextts2' })
    const repeated = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-001' },
      now: '2026-07-17T00:06:00.000Z',
    })
    expect(repeated.revision).toBe(reconciled.revision)
    expect(repeated).toEqual(reconciled)
    const foreignSession = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-001', sessionId: 'voice-foreign', source: 'indextts2', artifactId: 'audio-001' },
      now: '2026-07-17T00:07:00.000Z',
    })
    expect(foreignSession).toEqual(reconciled)
  })

  it('allows a valid ready task to repair the same failed operation but ignores foreign and stale tasks', async () => {
    const projectId = id('reconcile-failed')
    await createProjectState({ projectId, script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' } })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-001', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })
    const failed = await failProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', error: { code: 'project_stage_complete_failed', message: '写入中断' },
    })
    const foreign = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-001', sessionId: 'voice-other', source: 'indextts2', artifactId: 'audio-001' },
    })
    expect(foreign).toEqual(failed)
    const stale = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'failed', operationId: 'audio-old', sessionId: 'voice-001', source: 'indextts2', error: { code: 'late', message: '旧失败' } },
    })
    expect(stale).toEqual(failed)
    const repaired = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-001' },
    })
    expect(repaired.stages.voice).toMatchObject({ status: 'ready', artifactId: 'audio-001' })
  })

  it('fails only a matching active operation from failed or missing stale task evidence', async () => {
    const projectId = id('reconcile-interrupted')
    await createProjectState({ projectId, script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' } })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-001', now: '2026-07-17T00:00:00.000Z',
    })
    const withinWindow = await reconcileProjectStageOperation({
      projectId, stage: 'voice', task: { status: 'missing', sessionId: 'voice-001', source: 'indextts2' },
      now: '2026-07-17T00:15:00.000Z', missingTaskRecoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(withinWindow.stages.voice.status).toBe('queued')
    const foreign = await reconcileProjectStageOperation({
      projectId, stage: 'voice', task: { status: 'missing', sessionId: 'voice-other', source: 'indextts2' },
      now: '2026-07-17T01:00:00.000Z', missingTaskRecoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(foreign.revision).toBe(withinWindow.revision)
    const interrupted = await reconcileProjectStageOperation({
      projectId, stage: 'voice', task: { status: 'missing', sessionId: 'voice-001', source: 'indextts2' },
      now: '2026-07-17T00:15:00.001Z', missingTaskRecoveryWindowMs: 15 * 60 * 1_000,
    })
    expect(interrupted.stages.voice).toMatchObject({ status: 'failed', error: { code: 'task_interrupted' } })
  })

  it('uses the actual stage name when recovering an interrupted digital-human task', async () => {
    const projectId = id('reconcile-digital-human-interrupted')
    await createProjectState({ projectId, script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' } })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-001', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-001.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-001', text: '正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-001', sessionId: 'voice-001', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })
    await completeProjectStageOperation({ projectId, stage: 'voice', operationId: 'audio-001', artifactId: 'audio-001' })
    await beginProjectStageOperation({
      projectId, stage: 'digitalHuman', operationId: 'render-001', sessionId: 'avatar-001', source: 'heygem',
      expectedUpstreamArtifactId: 'audio-001', now: '2026-07-17T00:00:00.000Z',
    })

    const interrupted = await reconcileProjectStageOperation({
      projectId, stage: 'digitalHuman', task: { status: 'missing', sessionId: 'avatar-001', source: 'heygem' },
      now: '2026-07-17T00:15:00.001Z', missingTaskRecoveryWindowMs: 15 * 60 * 1_000,
    })

    expect(interrupted.stages.digitalHuman).toMatchObject({
      status: 'failed',
      error: { code: 'task_interrupted', message: '数字人生成曾被异常中断，请重新发起。' },
    })
  })

  it('turns a matching ready task with a missing artifact into a typed project failure', async () => {
    const projectId = id('reconcile-missing-artifact')
    await createProjectState({ projectId, script: { ...emptyScript(), artifactId: 'script-001', approvalStatus: 'approved', body: '正文' } })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-missing', sessionId: 'voice-001', source: 'indextts2', expectedUpstreamArtifactId: 'script-001',
    })
    const reconciled = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-missing', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-missing' },
    })
    expect(reconciled.stages.voice).toMatchObject({
      status: 'failed', operation: { id: 'audio-missing' }, error: { code: 'invalid_audio_artifact' },
    })
    const repeated = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-missing', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-missing' },
    })
    expect(repeated.revision).toBe(reconciled.revision)
  })

  it('rejects a recovered audio artifact from a different script lineage', async () => {
    const projectId = id('reconcile-script-lineage')
    await createProjectState({ projectId, script: { ...emptyScript(), artifactId: 'script-current', approvalStatus: 'approved', body: '当前正文' } })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace, artifactId: 'audio-foreign-script', sessionId: 'voice-001', status: 'ready', source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-foreign-script.wav'), durationSeconds: 2,
      parameters: { scriptArtifactId: 'script-old', text: '旧正文', speed: 1, emotionAlpha: 0.2, useRandom: false, outputFormat: 'wav' },
    })
    await beginProjectStageOperation({
      projectId, stage: 'voice', operationId: 'audio-foreign-script', sessionId: 'voice-001', source: 'indextts2',
      expectedUpstreamArtifactId: 'script-current',
    })
    const reconciled = await reconcileProjectStageOperation({
      projectId, stage: 'voice',
      task: { status: 'ready', operationId: 'audio-foreign-script', sessionId: 'voice-001', source: 'indextts2', artifactId: 'audio-foreign-script' },
    })
    expect(reconciled.stages.voice).toMatchObject({ status: 'failed', error: { code: 'audio_script_mismatch' } })
  })

  it('keeps the previous project.json readable when atomic replacement fails', async () => {
    const projectId = id('atomic-failure')
    const created = await createProjectState({ projectId, script: emptyScript() })
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const target = path.join(workspace.rootPath, 'project.json')
    const originalRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(target)) {
        throw Object.assign(new Error('simulated replace failure'), { code: 'EIO' })
      }
      return originalRename(from, to)
    })

    await expect(mutateProjectState(projectId, {
      operation: 'update_script', script: { ...created.script, title: '不应提交' }, expectedRevision: created.revision,
    })).rejects.toThrow('simulated replace failure')
    vi.restoreAllMocks()
    await expect(getProjectState(projectId)).resolves.toEqual(created)
    expect((await fs.readdir(workspace.rootPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
