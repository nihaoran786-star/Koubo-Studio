import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultEditPlan } from './edit-plan'
import {
  buildSrt,
  buildKeepSegments,
  buildVideoEditingFfmpegArgs,
  classifyVideoEditingProcessError,
  parseSilenceIntervals,
  runVideoEditingSkill,
  verifyPostProductionOutput,
  type RunVideoEditingSkillInput,
  type VideoEditingProcessRunner,
} from './video-editing-skill-runner'

const tmpRoots: string[] = []
afterEach(async () => { await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true }))); tmpRoots.length = 0 })

describe('controlled local ffmpeg editor', () => {
  it('compiles EditPlan into fixed ffmpeg arguments without a shell', () => {
    const input = makeInput('C:\workspace')
    input.plan = { ...createDefaultEditPlan({ ratio: '1:1', subtitleStyle: 'cyan' }), audio: { voiceVolume: 0.8 } }
    const args = buildVideoEditingFfmpegArgs({ input, subtitlePath: input.subtitlePath })
    expect(args).toEqual(expect.arrayContaining(['-vf', expect.stringContaining('scale=1080:1080'), '-af', 'volume=0.8', '-c:v', 'libx264']))
    expect(args.join(' ')).toContain('subtitles=')
    expect(args.join(' ')).not.toContain('powershell')
  })

  it('creates timed multi-cue SRT for the whole script duration', () => {
    const srt = buildSrt('第一句话。第二句话很重要！第三句话。', 9, 8)
    expect(srt).toContain('00:00:00,000 -->')
    expect(srt).toContain('00:00:09,000')
    expect(srt.match(/-->/g)?.length).toBeGreaterThan(1)
  })

  it('turns detected silence into padded keep segments', () => {
    const silences = parseSilenceIntervals(
      'silence_start: 1.2\nsilence_end: 2.2 | silence_duration: 1\nsilence_start: 7.5\nsilence_end: 9',
      10,
    )
    expect(buildKeepSegments(10, silences, 0.12)).toEqual([
      { startSeconds: 0, endSeconds: 1.3199999999999998 },
      { startSeconds: 2.08, endSeconds: 7.62 },
      { startSeconds: 8.88, endSeconds: 10 },
    ])
  })

  it('uses controlled trim/concat filters and audio fades for tight pacing', () => {
    const input = makeInput('C:\\workspace')
    const args = buildVideoEditingFfmpegArgs({
      input,
      subtitlePath: input.subtitlePath,
      timelineSegments: [
        { startSeconds: 0, endSeconds: 1.4 },
        { startSeconds: 2.1, endSeconds: 4.5 },
      ],
    })
    const command = args.join(' ')
    expect(command).toContain('trim=start=0:end=1.4')
    expect(command).toContain('concat=n=2:v=1:a=1')
    expect(command).toContain('afade=t=in')
    expect(command).toContain('subtitles=')
    expect(command).not.toContain('powershell')
  })

  it('runs video and cover commands, then verifies all outputs', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-post-run-'))
    tmpRoots.push(root)
    const input = makeInput(root)
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
    const runner = vi.fn<VideoEditingProcessRunner>(async ({ args }) => {
      const target = args.at(-1)!
      await fs.writeFile(target, target.endsWith('.png') ? 'cover' : 'video')
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })
    const result = await runVideoEditingSkill(input, { runner, probeDuration: async () => 9.5 })
    expect(result).toMatchObject({ status: 'ok', durationSeconds: 9.5 })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'ffmpeg' }))
    await expect(fs.readFile(input.subtitlePath!, 'utf8')).resolves.toContain('-->')
  })

  it('rejects output paths outside workspace artifacts', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-post-output-'))
    tmpRoots.push(root)
    await expect(verifyPostProductionOutput({ workspacePath: root, outputPath: path.join(path.dirname(root), 'final.mp4'), probeDuration: async () => 1 })).rejects.toMatchObject({ code: 'output_path_escape' })
  })

  it('does not expose final output files when ffmpeg fails', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-post-failed-'))
    tmpRoots.push(root)
    const input = makeInput(root)
    const runner = vi.fn<VideoEditingProcessRunner>(async ({ args }) => {
      await fs.mkdir(path.dirname(args.at(-1)!), { recursive: true })
      await fs.writeFile(args.at(-1)!, 'partial')
      return { exitCode: 1, stdout: '', stderr: 'render failed', timedOut: false }
    })

    await expect(runVideoEditingSkill(input, { runner, probeDuration: async () => 9.5 }))
      .resolves.toMatchObject({ status: 'skill_error' })
    await expect(fs.stat(input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(input.subtitlePath!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(input.coverPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(path.dirname(input.outputPath))).filter((name) => name.includes('.candidate'))).toEqual([])
  })

  it('classifies dependency, invalid input and timeout failures', () => {
    expect(classifyVideoEditingProcessError({ exitCode: 1, stdout: '', stderr: "ffmpeg was not found", timedOut: false })).toMatchObject({ code: 'dependency_missing' })
    expect(classifyVideoEditingProcessError({ exitCode: 1, stdout: '', stderr: 'moov atom not found', timedOut: false })).toMatchObject({ code: 'input_video_invalid' })
    expect(classifyVideoEditingProcessError({ exitCode: null, stdout: '', stderr: '', timedOut: true })).toMatchObject({ code: 'skill_timeout' })
  })
})

function makeInput(root: string): RunVideoEditingSkillInput {
  const postRoot = path.join(root, 'artifacts', 'post-production')
  return {
    projectId: 'demo',
    workspacePath: root,
    renderOutputPath: path.join(root, 'artifacts', 'render', 'render.mp4'),
    scriptText: '第一句话。第二句话。',
    request: '加字幕并整理成片',
    plan: createDefaultEditPlan(),
    outputPath: path.join(postRoot, 'final.mp4'),
    subtitlePath: path.join(postRoot, 'final.srt'),
    coverPath: path.join(postRoot, 'final.png'),
    skill: { skillId: 'builtin:post-production-cut-review', skillName: 'post-production-cut-review' },
  }
}
