import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createDefaultEditPlan } from './edit-plan'
import { generateAiEditPlan } from './edit-plan-agent'
import { runVideoEditingSkill } from './video-editing-skill-runner'

const execFileAsync = promisify(execFile)
const maybeIt = process.env.RUN_AI_EDIT_REAL_MEDIA_SMOKE === '1' ? it : it.skip

describe('AI edit real digital-human media smoke', () => {
  maybeIt('uses the configured provider once and edits a real HeyGem video locally', async () => {
    const sourcePath = path.resolve(requiredEnv('AI_EDIT_REAL_MEDIA_PATH'))
    const workspacePath = path.resolve(requiredEnv('AI_EDIT_REAL_OUTPUT_ROOT'))
    const renderRoot = path.join(workspacePath, 'artifacts', 'render')
    const postRoot = path.join(workspacePath, 'artifacts', 'post-production')
    const renderOutputPath = path.join(renderRoot, 'real-heygem-input.mp4')
    const outputPath = path.join(postRoot, 'real-heygem-auto-edited.mp4')
    const subtitlePath = path.join(postRoot, 'real-heygem-auto-edited.srt')
    const coverPath = path.join(postRoot, 'real-heygem-auto-edited.png')
    await fs.mkdir(renderRoot, { recursive: true })
    await fs.mkdir(postRoot, { recursive: true })
    await fs.copyFile(sourcePath, renderOutputPath)

    const sourceProbe = await probe(renderOutputPath)
    const script = process.env.AI_EDIT_REAL_SCRIPT?.trim() ||
      '这是一次真实数字人口播视频的低 Token 自动剪辑测试。'
    const basePlan = createDefaultEditPlan({ ratio: '9:16', subtitleStyle: 'bold' })
    basePlan.timeline.minSilenceMs = 350
    basePlan.timeline.keepPaddingMs = 100

    const generated = await generateAiEditPlan({
      instruction: '做成抖音竖屏口播，字幕醒目，去掉长停顿，节奏紧凑，不添加不存在的素材。',
      script,
      currentPlan: basePlan,
      availableAssets: [],
      videoDurationSeconds: sourceProbe.durationSeconds,
      cacheDirectory: path.join(postRoot, '.ai-plan-cache'),
    })
    expect(generated.status).toBe('ok')
    if (generated.status !== 'ok') throw new Error(generated.error.message)
    expect(generated.plan.timeline.removeSilence).toBe(true)
    expect(generated.usage).toMatchObject({
      maxOutputTokens: 700,
    })
    expect(generated.usage?.source).toMatch(/^(model|cache)$/)

    const edited = await runVideoEditingSkill({
      projectId: 'real-heygem-auto-edit',
      workspacePath,
      renderOutputPath,
      scriptText: script,
      request: '竖屏、醒目字幕、自动去长停顿',
      plan: generated.plan,
      outputPath,
      subtitlePath,
      coverPath,
      skill: {
        skillId: 'builtin:post-production-cut-review',
        skillName: 'post-production-cut-review',
      },
    })
    expect(edited.status).toBe('ok')
    if (edited.status !== 'ok') throw new Error(JSON.stringify(edited.error))

    const outputProbe = await probe(outputPath)
    expect(outputProbe.video).toMatchObject({
      codec_name: 'h264',
      width: 720,
      height: 1280,
    })
    expect(outputProbe.audio?.codec_name).toBe('aac')
    expect(outputProbe.durationSeconds).toBeGreaterThan(0)
    expect(outputProbe.durationSeconds).toBeLessThan(sourceProbe.durationSeconds)
    await expect(fs.stat(coverPath)).resolves.toMatchObject({ size: expect.any(Number) })
    await expect(fs.readFile(subtitlePath, 'utf8')).resolves.toContain(script.slice(0, 8))

    console.info('Real AI edit smoke:', {
      sourcePath,
      outputPath,
      inputDurationSeconds: sourceProbe.durationSeconds,
      outputDurationSeconds: outputProbe.durationSeconds,
      estimatedInputTokens: generated.usage?.estimatedInputTokens,
      maxOutputTokens: generated.usage?.maxOutputTokens,
      reportedInputTokens: generated.usage?.reportedInputTokens,
      reportedOutputTokens: generated.usage?.reportedOutputTokens,
      reportedTotalTokens: generated.usage?.reportedTotalTokens,
      decisionSource: generated.usage?.source,
      video: `${outputProbe.video?.codec_name} ${outputProbe.video?.width}x${outputProbe.video?.height}`,
      audio: outputProbe.audio?.codec_name,
    })
  }, 180_000)
})

async function probe(filePath: string) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height:format=duration',
    '-of',
    'json',
    filePath,
  ])
  const payload = JSON.parse(stdout) as {
    streams: Array<{
      codec_type: 'video' | 'audio'
      codec_name: string
      width?: number
      height?: number
    }>
    format: { duration: string }
  }
  return {
    durationSeconds: Number(payload.format.duration),
    video: payload.streams.find((stream) => stream.codec_type === 'video'),
    audio: payload.streams.find((stream) => stream.codec_type === 'audio'),
  }
}

function requiredEnv(key: string) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}
