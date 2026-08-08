import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { saveRenderArtifact } from '@/lib/artifacts/render-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { runPostProductionAgent } from './post-production-agent-service'
import { createDefaultEditPlan } from './edit-plan'
import { saveEditMediaAsset } from './edit-media-asset'

const execFileAsync = promisify(execFile)
const projectId = 'post-production-local-skill-smoke'
const shouldRun = process.env.RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE === '1'
const maybeIt = shouldRun ? it : it.skip

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('post-production local skill smoke', () => {
  maybeIt('runs the built-in video editing skill and saves a post-production artifact', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const renderOutputPath = path.join(workspace.artifactsPath, 'render', 'render-smoke.mp4')
    await fs.mkdir(path.dirname(renderOutputPath), { recursive: true })
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=720x1280:d=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=24000',
      '-shortest',
      '-pix_fmt',
      'yuv420p',
      renderOutputPath,
    ])

    await saveScriptArtifact({
      workspace,
      artifactId: 'script-smoke',
      sessionId: 'script-session',
      approvalStatus: 'approved',
      content: {
        title: '后期 smoke',
        hook: '这是一次后期 smoke。',
        body: '这是一次后期剪辑智能体 smoke。',
        caption: '后期 smoke',
        tags: ['#smoke'],
        durationSeconds: 1,
        voiceNotes: '',
        shotNotes: '',
        riskNotes: '',
      },
    })
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-smoke',
      sessionId: 'voice-session',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-smoke.wav'),
      durationSeconds: 1,
      parameters: {
        scriptArtifactId: 'script-smoke',
        text: '这是一次后期剪辑智能体 smoke。',
        speed: 1,
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav',
      },
    })
    await saveRenderArtifact({
      workspace,
      artifactId: 'render-smoke',
      sessionId: 'avatar-session',
      status: 'ready',
      source: 'heygem',
      scriptArtifactId: 'script-smoke',
      audioArtifactId: 'audio-smoke',
      outputPath: renderOutputPath,
      durationSeconds: 1,
      avatar: {
        source: 'library',
        id: 'a1',
        name: '林夕',
      },
      mode: 'standard',
    })

    const sourceBgm = path.join(workspace.rootPath, 'smoke-bgm.mp3')
    const sourceIntro = path.join(workspace.rootPath, 'smoke-intro.mp4')
    const sourceOutro = path.join(workspace.rootPath, 'smoke-outro.mp4')
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', sourceBgm])
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:d=0.5', '-pix_fmt', 'yuv420p', sourceIntro])
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=720x1280:d=0.5', '-pix_fmt', 'yuv420p', sourceOutro])
    const bgm = await saveEditMediaAsset({ workspace, kind: 'background_music', originalFilename: 'smoke.mp3', contentType: 'audio/mpeg', bytes: await fs.readFile(sourceBgm) })
    const intro = await saveEditMediaAsset({ workspace, kind: 'intro', originalFilename: 'intro.mp4', contentType: 'video/mp4', bytes: await fs.readFile(sourceIntro) })
    const outro = await saveEditMediaAsset({ workspace, kind: 'outro', originalFilename: 'outro.mp4', contentType: 'video/mp4', bytes: await fs.readFile(sourceOutro) })

    const plan = createDefaultEditPlan({ ratio: '9:16', subtitleStyle: 'cyan' })
    plan.backgroundMusic = { enabled: true, assetId: bgm.assetId, volume: 0.08 }
    plan.intro = { enabled: true, assetId: intro.assetId }
    plan.outro = { enabled: true, assetId: outro.assetId }

    const result = await runPostProductionAgent({
      projectId,
      sessionId: 'post-session',
      input: {
        renderArtifactId: 'render-smoke',
        request: '加字幕并整理成片',
        plan,
      },
    })

    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    expect(result.status).toBe('ok')
    expect(result.artifact).toMatchObject({
      artifactType: 'post-production',
      status: 'ready',
      source: 'local_ffmpeg',
      renderArtifactId: 'render-smoke',
      scriptArtifactId: 'script-smoke',
      parameters: {
        plan: expect.objectContaining({
          version: 1,
          ratio: '9:16',
          subtitles: expect.objectContaining({ enabled: true, style: 'cyan' }),
        }),
      },
    })
    expect(result.artifact.durationSeconds).toBeGreaterThan(1.5)
    await expect(fs.stat(result.artifact.outputPath)).resolves.toMatchObject({ size: expect.any(Number) })
    await expect(fs.stat(result.artifact.subtitlePath!)).resolves.toMatchObject({ size: expect.any(Number) })
    await expect(fs.stat(result.artifact.coverPath!)).resolves.toMatchObject({ size: expect.any(Number) })
    const probe = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height',
      '-of', 'json',
      result.artifact.outputPath,
    ])
    const streams = (JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number }> }).streams
    expect(streams).toEqual(expect.arrayContaining([
      expect.objectContaining({ codec_type: 'video', width: 720, height: 1280 }),
      expect.objectContaining({ codec_type: 'audio' }),
    ]))
    await expect(fs.readFile(result.artifact.subtitlePath!, 'utf8')).resolves.toContain('这是一次后期剪辑智能体smoke。')
  })
})
