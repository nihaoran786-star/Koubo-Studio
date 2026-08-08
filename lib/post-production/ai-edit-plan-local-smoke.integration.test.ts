import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createDefaultEditPlan, type EditPlanV1 } from './edit-plan'
import { generateAiEditPlan } from './edit-plan-agent'
import { runVideoEditingSkill } from './video-editing-skill-runner'

const execFileAsync = promisify(execFile)
const maybeIt = process.env.RUN_AI_EDIT_LOCAL_SMOKE === '1' ? it : it.skip

interface ProbeOutput {
  streams: Array<{
    codec_type: string
    codec_name: string
    width?: number
    height?: number
  }>
  format: { duration: string }
}

describe('AI edit plan local smoke', () => {
  maybeIt('uses the production OpenAI-compatible request and ffmpeg editing runner', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-ai-edit-smoke-'))
    const fixturePlan: EditPlanV1 = {
      version: 1,
      ratio: '9:16',
      framing: { mode: 'cover' },
      timeline: {
        removeSilence: true,
        silenceThresholdDb: -42,
        minSilenceMs: 650,
        keepPaddingMs: 120,
      },
      subtitles: { enabled: true, style: 'bold', maxCharsPerCue: 12 },
      creative: {
        preset: 'energetic',
        motion: 'punch',
        captions: 'impact',
        colorGrade: 'vivid',
        soundEffects: 'subtle',
        hook: '本地精剪验证',
        emphasis: ['真实', 'AI 精剪'],
        effects: ['animated-captions', 'hook-card', 'punch-zoom', 'progress-line', 'light-leak'],
      },
      audio: { voiceVolume: 0.9 },
      backgroundMusic: { enabled: false, volume: 0.16 },
      intro: { enabled: false },
      outro: { enabled: false },
      cover: { timestampSeconds: 0.2 },
      export: { format: 'mp4', videoCodec: 'h264' },
    }
    let requestCount = 0
    let server: Server | undefined
    let port = 0
    let probeSummary: ProbeOutput | undefined

    try {
      server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        requestCount += 1
        for await (const _chunk of request) {
          // Consume the production request without retaining or logging its body.
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                v: 1,
                r: fixturePlan.ratio,
                f: fixturePlan.framing.mode,
                s: fixturePlan.subtitles.style,
                c: fixturePlan.subtitles.maxCharsPerCue,
                vv: fixturePlan.audio.voiceVolume,
                bg: null,
                bv: fixturePlan.backgroundMusic.volume,
                i: null,
                o: null,
                ct: fixturePlan.cover.timestampSeconds,
                p: 'tight',
                ep: fixturePlan.creative.preset,
                mo: fixturePlan.creative.motion,
                cp: fixturePlan.creative.captions,
                cg: fixturePlan.creative.colorGrade,
                fx: fixturePlan.creative.soundEffects,
                hk: fixturePlan.creative.hook,
                kw: fixturePlan.creative.emphasis,
                ef: fixturePlan.creative.effects,
              }),
            },
          }],
        }))
      })
      await listenOnLoopback(server)
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Fixture 未取得本机 TCP 端口。')
      port = address.port

      const generated = await generateAiEditPlan({
        instruction: '生成竖屏成片，使用醒目字幕并保留原声。',
        script: '这是一次真实的本地 AI 精剪联合验证。',
        currentPlan: createDefaultEditPlan(),
        availableAssets: [],
        resolveProvider: async () => ({
          status: 'ok',
          source: 'model_provider_resolution',
          provider: {
            providerId: 'local-smoke-fixture',
            providerKind: 'local_openai_compatible',
            modelId: 'fixture-edit-plan',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            authHeader: false,
          },
        }),
      })

      expect(requestCount).toBe(1)
      expect(generated).toMatchObject({
        status: 'ok',
        source: 'ai_edit_plan_agent',
        plan: fixturePlan,
        usage: { source: 'model', maxOutputTokens: 700 },
      })
      if (generated.status !== 'ok') throw new Error(generated.error.message)

      const workspacePath = path.join(root, 'workspace')
      const renderOutputPath = path.join(workspacePath, 'artifacts', 'render', 'input.mp4')
      const postProductionRoot = path.join(workspacePath, 'artifacts', 'post-production')
      const outputPath = path.join(postProductionRoot, 'final.mp4')
      const subtitlePath = path.join(postProductionRoot, 'final.srt')
      const coverPath = path.join(postProductionRoot, 'cover.jpg')
      await fs.mkdir(path.dirname(renderOutputPath), { recursive: true })
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x183153:s=320x240:r=25:d=2.6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.8',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.8',
        '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]',
        '-map', '0:v:0', '-map', '[a]', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        renderOutputPath,
      ])

      const edited = await runVideoEditingSkill({
        projectId: 'ai-edit-local-smoke',
        workspacePath,
        renderOutputPath,
        scriptText: '这是一次真实的本地 AI 精剪联合验证。',
        request: '生成竖屏成片，使用醒目字幕并保留原声。',
        plan: generated.plan,
        outputPath,
        subtitlePath,
        coverPath,
        skill: { skillId: 'builtin-video-editing', skillName: '本地视频剪辑' },
      })

      if (edited.status !== 'ok') throw new Error(JSON.stringify(edited.error))
      expect(edited.status).toBe('ok')
      expect(edited.durationSeconds).toBeGreaterThan(0)
      const subtitle = await fs.readFile(subtitlePath, 'utf8')
      expect(subtitle).toContain('这是一次真实的本地AI精')
      expect(subtitle).toContain('剪联合验证。')
      await expect(fs.stat(coverPath)).resolves.toMatchObject({ size: expect.any(Number) })

      const probe = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
        '-of', 'json',
        outputPath,
      ])
      probeSummary = JSON.parse(probe.stdout) as ProbeOutput
      const durationSeconds = Number.parseFloat(probeSummary.format.duration)
      expect(durationSeconds).toBeGreaterThan(0)
      expect(durationSeconds).toBeLessThan(2.2)
      expect(probeSummary.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ codec_type: 'video', codec_name: 'h264', width: 720, height: 1280 }),
        expect.objectContaining({ codec_type: 'audio', codec_name: 'aac' }),
      ]))
    } finally {
      if (server) await closeFixture(server)
      await fs.rm(root, { recursive: true, force: true })
    }

    expect(server?.listening).toBe(false)
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(probeSummary).toBeDefined()
    const video = probeSummary?.streams.find((stream) => stream.codec_type === 'video')
    const audio = probeSummary?.streams.find((stream) => stream.codec_type === 'audio')
    console.info('AI edit local smoke:', {
      requestCount,
      video: `${video?.codec_name} ${video?.width}x${video?.height}`,
      audio: audio?.codec_name,
      durationSeconds: Number.parseFloat(probeSummary?.format.duration ?? '0'),
      serverClosed: server?.listening === false,
      temporaryRootRemoved: true,
    })
  }, 120_000)
})

function listenOnLoopback(server: Server) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function closeFixture(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}
