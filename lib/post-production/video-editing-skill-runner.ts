import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import type { EditPlanV1 } from './edit-plan'
import { renderRemotionEnhancement } from './remotion-render-adapter'

export interface VideoEditingSkillDescriptor {
  skillId: string
  skillName: string
  scriptPath?: string
}

export interface RunVideoEditingSkillInput {
  projectId: string
  workspacePath: string
  renderOutputPath: string
  scriptText: string
  request: string
  plan: EditPlanV1
  outputPath: string
  subtitlePath?: string
  coverPath?: string
  skill: VideoEditingSkillDescriptor
  editAssets?: {
    backgroundMusicPath?: string
    introPath?: string
    outroPath?: string
  }
}

export type RunVideoEditingSkillResult =
  | { status: 'ok'; source: 'video_editing_skill'; outputPath: string; subtitlePath?: string; coverPath?: string; durationSeconds: number }
  | { status: 'skill_error'; source: 'video_editing_skill'; error: { code: string; message: string } }

export interface VideoEditingProcessResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface VideoEditingProcessRunInput { command: string; args: string[]; timeoutMs: number }
export type VideoEditingProcessRunner = (input: VideoEditingProcessRunInput) => Promise<VideoEditingProcessResult>
export type ProbePostProductionDuration = (input: { outputPath: string; ffprobePath: string }) => Promise<number>
export interface TimelineSegment { startSeconds: number; endSeconds: number }

export class VideoEditingSkillError extends Error {
  source = 'video_editing_skill' as const
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'VideoEditingSkillError'
  }
}

export async function verifyPostProductionOutput(input: {
  workspacePath: string
  outputPath: string
  subtitlePath?: string
  coverPath?: string
  ffprobePath?: string
  probeDuration: ProbePostProductionDuration
}) {
  const postRoot = path.join(input.workspacePath, 'artifacts', 'post-production')
  const outputPath = assertPostProductionPath(postRoot, input.outputPath)
  const subtitlePath = input.subtitlePath ? assertPostProductionPath(postRoot, input.subtitlePath) : undefined
  const coverPath = input.coverPath ? assertPostProductionPath(postRoot, input.coverPath) : undefined
  await assertNonEmptyFile(outputPath, 'output_missing', '本地剪辑没有生成有效成片。')
  if (subtitlePath) await assertNonEmptyFile(subtitlePath, 'subtitle_missing', '本地剪辑没有生成有效字幕文件。')
  if (coverPath) await assertNonEmptyFile(coverPath, 'cover_missing', '本地剪辑没有生成有效封面文件。')
  const durationSeconds = await input.probeDuration({ outputPath, ffprobePath: input.ffprobePath ?? 'ffprobe' })
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new VideoEditingSkillError('invalid_duration', '后期成片时长无效。')
  return { outputPath, subtitlePath, coverPath, durationSeconds }
}

export async function runVideoEditingSkill(
  input: RunVideoEditingSkillInput,
  options: {
    runner?: VideoEditingProcessRunner
    probeDuration?: ProbePostProductionDuration
    ffmpegPath?: string
    ffprobePath?: string
    timeoutMs?: number
  } = {},
): Promise<RunVideoEditingSkillResult> {
  const candidates: string[] = []
  try {
    if (input.skill.scriptPath) return skillError('client_skill_script_forbidden', '本地剪辑执行器不接受脚本路径。')
    if (input.plan.backgroundMusic.enabled && !input.editAssets?.backgroundMusicPath) return skillError('background_music_missing', '未找到所选背景音乐素材。')
    if (input.plan.intro.enabled && !input.editAssets?.introPath) return skillError('intro_missing', '未找到所选片头素材。')
    if (input.plan.outro.enabled && !input.editAssets?.outroPath) return skillError('outro_missing', '未找到所选片尾素材。')
    const postRoot = path.join(input.workspacePath, 'artifacts', 'post-production')
    const finalOutputPath = assertPostProductionPath(postRoot, input.outputPath)
    const finalSubtitlePath = input.subtitlePath ? assertPostProductionPath(postRoot, input.subtitlePath) : undefined
    const finalCoverPath = input.coverPath ? assertPostProductionPath(postRoot, input.coverPath) : undefined
    const outputPath = candidatePath(finalOutputPath)
    const subtitlePath = finalSubtitlePath ? candidatePath(finalSubtitlePath) : undefined
    const coverPath = finalCoverPath ? candidatePath(finalCoverPath) : undefined
    candidates.push(outputPath, ...(subtitlePath ? [subtitlePath] : []), ...(coverPath ? [coverPath] : []))
    input = { ...input, outputPath, subtitlePath, coverPath }
    if (input.plan.subtitles.enabled && !subtitlePath) return skillError('subtitle_path_missing', '字幕已启用但缺少受控字幕输出路径。')

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const probeDuration = options.probeDuration ?? probeDurationWithFfprobe
    const ffprobePath = options.ffprobePath ?? (process.env.FFPROBE_PATH?.trim() || 'ffprobe')
    const inputDuration = await probeDuration({ outputPath: input.renderOutputPath, ffprobePath })
    if (!Number.isFinite(inputDuration) || inputDuration <= 0) return skillError('input_video_invalid', '数字人视频时长无效。')
    const runner = options.runner ?? runProcess
    const ffmpegPath = options.ffmpegPath ?? (process.env.FFMPEG_PATH?.trim() || 'ffmpeg')
    const timeoutMs = options.timeoutMs ?? 180000
    let timelineSegments: TimelineSegment[] | undefined
    if (input.plan.timeline.removeSilence) {
      const detected = await detectSpeechTimeline({
        inputPath: input.renderOutputPath,
        durationSeconds: inputDuration,
        thresholdDb: input.plan.timeline.silenceThresholdDb,
        minSilenceMs: input.plan.timeline.minSilenceMs,
        keepPaddingMs: input.plan.timeline.keepPaddingMs,
        ffmpegPath,
        runner,
        timeoutMs: Math.min(timeoutMs, 60000),
      })
      if (detected.status === 'failed') return skillError(detected.error.code, detected.error.message)
      timelineSegments = detected.segments
    }
    const outputDuration = timelineSegments
      ? timelineSegments.reduce((total, segment) => total + segment.endSeconds - segment.startSeconds, 0)
      : inputDuration
    if (subtitlePath) {
      await fs.writeFile(
        subtitlePath,
        buildSrt(input.scriptText || input.request, outputDuration, input.plan.subtitles.maxCharsPerCue),
        'utf8',
      )
    }

    const hasBumpers = Boolean(input.editAssets?.introPath || input.editAssets?.outroPath)
    const mainOutputPath = hasBumpers ? `${outputPath}.main.mp4` : outputPath
    const useRemotion = input.plan.ratio === '9:16' && input.plan.creative.effects.length > 0
    const ffmpegOutputPath = useRemotion ? `${mainOutputPath}.base.mp4` : mainOutputPath
    if (ffmpegOutputPath !== mainOutputPath) candidates.push(ffmpegOutputPath)
    const renderResult = await runner({
      command: ffmpegPath,
      args: buildVideoEditingFfmpegArgs({
        input: { ...input, outputPath: ffmpegOutputPath },
        subtitlePath: useRemotion ? undefined : subtitlePath,
        timelineSegments,
      }),
      timeoutMs,
    })
    if (renderResult.exitCode !== 0 || renderResult.timedOut) {
      const error = classifyVideoEditingProcessError(renderResult)
      return skillError(error.code, error.message)
    }

    if (useRemotion) {
      const enhanced = await renderRemotionEnhancement({
        postProductionRoot: postRoot,
        inputPath: ffmpegOutputPath,
        outputPath: mainOutputPath,
        durationSeconds: outputDuration,
        scriptText: input.scriptText || input.request,
        plan: input.plan,
        runner,
        timeoutMs,
      })
      if (enhanced.status === 'failed') {
        return skillError(enhanced.error.code, enhanced.error.message)
      }
    }

    if (hasBumpers) {
      const concatResult = await renderWithBumpers({ input, mainOutputPath, outputPath, ffmpegPath, ffprobePath, runner, probeDuration, timeoutMs })
      if (concatResult) return concatResult
    }

    if (coverPath) {
      const coverResult = await runner({
        command: ffmpegPath,
        args: ['-y', '-ss', String(Math.min(input.plan.cover.timestampSeconds, Math.max(0, outputDuration - 0.05))), '-i', outputPath, '-frames:v', '1', coverPath],
        timeoutMs: Math.min(timeoutMs, 60000),
      })
      if (coverResult.exitCode !== 0 || coverResult.timedOut) {
        const error = classifyVideoEditingProcessError(coverResult)
        return skillError('cover_generation_failed', error.message)
      }
    }

    const output = await verifyPostProductionOutput({
      workspacePath: input.workspacePath,
      outputPath,
      subtitlePath,
      coverPath,
      ffprobePath,
      probeDuration,
    })
    if (output.subtitlePath && finalSubtitlePath) await commitCandidate(output.subtitlePath, finalSubtitlePath)
    if (output.coverPath && finalCoverPath) await commitCandidate(output.coverPath, finalCoverPath)
    await commitCandidate(output.outputPath, finalOutputPath)
    return {
      status: 'ok',
      source: 'video_editing_skill',
      outputPath: finalOutputPath,
      subtitlePath: finalSubtitlePath,
      coverPath: finalCoverPath,
      durationSeconds: output.durationSeconds,
    }
  } catch (error) {
    if (error instanceof VideoEditingSkillError) return skillError(error.code, error.message)
    const message = error instanceof Error ? error.message : String(error)
    return skillError('skill_failed', message)
  } finally {
    await Promise.all(candidates.map((file) => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}

function candidatePath(finalPath: string) {
  const extension = path.extname(finalPath)
  const basename = path.basename(finalPath, extension)
  return path.join(path.dirname(finalPath), `.${basename}.${randomUUID()}.candidate${extension}`)
}

async function commitCandidate(candidate: string, finalPath: string) {
  const handle = await fs.open(candidate, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(candidate, finalPath)
}

export function buildVideoEditingFfmpegArgs(input: {
  input: RunVideoEditingSkillInput
  subtitlePath?: string
  timelineSegments?: TimelineSegment[]
}) {
  const { width, height } = dimensionsForRatio(input.input.plan.ratio)
  const filters = input.input.plan.framing.mode === 'cover'
    ? [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2`,
        'setsar=1',
      ]
    : [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        'setsar=1',
      ]
  if (input.input.plan.subtitles.enabled && input.subtitlePath) {
    filters.push(`subtitles='${escapeSubtitleFilterPath(input.subtitlePath)}':force_style='${subtitleForceStyle(input.input.plan.subtitles.style)}'`)
  }
  const bgmPath = input.input.plan.backgroundMusic.enabled ? input.input.editAssets?.backgroundMusicPath : undefined
  const args = ['-y', '-i', input.input.renderOutputPath]
  if (bgmPath) args.push('-stream_loop', '-1', '-i', bgmPath)
  if (input.timelineSegments?.length) {
    const complex: string[] = []
    const concatInputs: string[] = []
    input.timelineSegments.forEach((segment, index) => {
      const start = roundSeconds(segment.startSeconds)
      const end = roundSeconds(segment.endSeconds)
      const duration = Math.max(0.06, segment.endSeconds - segment.startSeconds)
      complex.push(
        `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=0.03,afade=t=out:st=${roundSeconds(Math.max(0, duration - 0.03))}:d=0.03[a${index}]`,
      )
      concatInputs.push(`[v${index}][a${index}]`)
    })
    complex.push(`${concatInputs.join('')}concat=n=${input.timelineSegments.length}:v=1:a=1[vcut][acut]`)
    complex.push(`[vcut]${filters.join(',')},fps=30[vout]`)
    if (bgmPath) {
      complex.push(
        `[acut]volume=${input.input.plan.audio.voiceVolume}[voice]`,
        `[1:a]volume=${input.input.plan.backgroundMusic.volume}[music]`,
        '[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]',
      )
    } else {
      complex.push(`[acut]volume=${input.input.plan.audio.voiceVolume}[aout]`)
    }
    args.push(
      '-filter_complex', complex.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart',
      '-shortest', input.input.outputPath,
    )
    return args
  }
  args.push(
    '-vf', `${filters.join(',')},fps=30`,
  )
  if (bgmPath) {
    args.push(
      '-filter_complex',
      `[0:a]volume=${input.input.plan.audio.voiceVolume}[voice];[1:a]volume=${input.input.plan.backgroundMusic.volume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
      '-map', '0:v:0', '-map', '[a]',
    )
  } else {
    args.push('-af', `volume=${input.input.plan.audio.voiceVolume}`)
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-shortest', input.input.outputPath,
  )
  return args
}

export async function detectSpeechTimeline(input: {
  inputPath: string
  durationSeconds: number
  thresholdDb: number
  minSilenceMs: number
  keepPaddingMs: number
  ffmpegPath: string
  runner: VideoEditingProcessRunner
  timeoutMs: number
}): Promise<
  | { status: 'ok'; segments?: TimelineSegment[] }
  | { status: 'failed'; error: { code: string; message: string } }
> {
  const result = await input.runner({
    command: input.ffmpegPath,
    args: [
      '-hide_banner',
      '-nostats',
      '-i',
      input.inputPath,
      '-af',
      `silencedetect=noise=${input.thresholdDb}dB:d=${roundSeconds(input.minSilenceMs / 1000)}`,
      '-f',
      'null',
      '-',
    ],
    timeoutMs: input.timeoutMs,
  })
  if (result.exitCode !== 0 || result.timedOut) {
    const classified = classifyVideoEditingProcessError(result)
    return {
      status: 'failed',
      error: {
        code: result.timedOut ? 'silence_detection_timeout' : 'silence_detection_failed',
        message: classified.message,
      },
    }
  }
  const intervals = parseSilenceIntervals(`${result.stderr}\n${result.stdout}`, input.durationSeconds)
  const segments = buildKeepSegments(
    input.durationSeconds,
    intervals,
    input.keepPaddingMs / 1000,
  )
  return { status: 'ok', ...(segments ? { segments } : {}) }
}

export function parseSilenceIntervals(output: string, durationSeconds: number) {
  const intervals: Array<{ startSeconds: number; endSeconds: number }> = []
  let pendingStart: number | undefined
  for (const line of output.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/)
    if (startMatch) {
      pendingStart = Math.max(0, Number(startMatch[1]))
      continue
    }
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/)
    if (!endMatch || pendingStart === undefined) continue
    const endSeconds = Math.min(durationSeconds, Number(endMatch[1]))
    if (Number.isFinite(endSeconds) && endSeconds > pendingStart) {
      intervals.push({ startSeconds: pendingStart, endSeconds })
    }
    pendingStart = undefined
  }
  if (pendingStart !== undefined && pendingStart < durationSeconds) {
    intervals.push({ startSeconds: pendingStart, endSeconds: durationSeconds })
  }
  return intervals
}

export function buildKeepSegments(
  durationSeconds: number,
  silences: Array<{ startSeconds: number; endSeconds: number }>,
  keepPaddingSeconds: number,
) {
  const segments: TimelineSegment[] = []
  let cursor = 0
  for (const silence of silences) {
    const cutStart = Math.max(cursor, silence.startSeconds + keepPaddingSeconds)
    const cutEnd = Math.min(durationSeconds, silence.endSeconds - keepPaddingSeconds)
    if (cutEnd - cutStart < 0.08) continue
    if (cutStart - cursor >= 0.05) {
      segments.push({ startSeconds: cursor, endSeconds: cutStart })
    }
    cursor = cutEnd
  }
  if (durationSeconds - cursor >= 0.05) {
    segments.push({ startSeconds: cursor, endSeconds: durationSeconds })
  }
  const keptDuration = segments.reduce(
    (total, segment) => total + segment.endSeconds - segment.startSeconds,
    0,
  )
  if (!segments.length || durationSeconds - keptDuration < 0.08) return undefined
  return segments
}

async function renderWithBumpers(input: {
  input: RunVideoEditingSkillInput
  mainOutputPath: string
  outputPath: string
  ffmpegPath: string
  ffprobePath: string
  runner: VideoEditingProcessRunner
  probeDuration: ProbePostProductionDuration
  timeoutMs: number
}): Promise<Extract<RunVideoEditingSkillResult, { status: 'skill_error' }> | undefined> {
  const clips: string[] = []
  const temporary: string[] = [input.mainOutputPath]
  try {
    for (const [label, source] of [
      ['intro', input.input.editAssets?.introPath],
      ['outro', input.input.editAssets?.outroPath],
    ] as const) {
      if (!source) continue
      const duration = await input.probeDuration({ outputPath: source, ffprobePath: input.ffprobePath })
      if (!Number.isFinite(duration) || duration <= 0) return skillError(`${label}_invalid`, `${label === 'intro' ? '片头' : '片尾'}素材时长无效。`)
      const normalized = `${input.outputPath}.${label}.mp4`
      temporary.push(normalized)
      const { width, height } = dimensionsForRatio(input.input.plan.ratio)
      const videoFilter = input.input.plan.framing.mode === 'cover'
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2,setsar=1,fps=30`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`
      const result = await input.runner({
        command: input.ffmpegPath,
        args: [
          '-y', '-i', source, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', videoFilter,
          '-map', '0:v:0', '-map', '1:a:0', '-t', String(duration),
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', normalized,
        ],
        timeoutMs: input.timeoutMs,
      })
      if (result.exitCode !== 0 || result.timedOut) {
        const error = classifyVideoEditingProcessError(result)
        return skillError(`${label}_render_failed`, error.message)
      }
    }
    const intro = temporary.find((item) => item.endsWith('.intro.mp4'))
    const outro = temporary.find((item) => item.endsWith('.outro.mp4'))
    clips.push(...(intro ? [intro] : []), input.mainOutputPath, ...(outro ? [outro] : []))
    const listPath = `${input.outputPath}.concat.txt`
    temporary.push(listPath)
    await fs.writeFile(listPath, clips.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
    const concat = await input.runner({
      command: input.ffmpegPath,
      args: ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', input.outputPath],
      timeoutMs: input.timeoutMs,
    })
    if (concat.exitCode !== 0 || concat.timedOut) {
      const error = classifyVideoEditingProcessError(concat)
      return skillError('bumper_concat_failed', error.message)
    }
    return undefined
  } finally {
    await Promise.all(temporary.map((file) => fs.rm(file, { force: true }).catch(() => undefined)))
  }
}

export function buildSrt(text: string, durationSeconds: number, maxCharsPerCue: number) {
  const normalized = text.replace(/\s+/g, '').trim() || '口播成片'
  const phrases = normalized.split(/(?<=[，。！？；,.!?;])/u).filter(Boolean)
  const cues: string[] = []
  for (const phrase of phrases.length ? phrases : [normalized]) {
    for (let index = 0; index < phrase.length; index += maxCharsPerCue) cues.push(phrase.slice(index, index + maxCharsPerCue))
  }
  const safeDuration = Math.max(0.2, durationSeconds)
  return `${cues.map((cue, index) => {
    const start = (safeDuration * index) / cues.length
    const end = (safeDuration * (index + 1)) / cues.length
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${cue}`
  }).join('\n\n')}\n`
}

export function classifyVideoEditingProcessError(result: VideoEditingProcessResult) {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.timedOut) return { code: 'skill_timeout', message: '本地剪辑超时，请检查输入视频大小。' }
  if (output.includes('not recognized') || output.includes('was not found') || output.includes('enoent')) {
    return { code: 'dependency_missing', message: '本地剪辑依赖 ffmpeg/ffprobe 不可用。' }
  }
  if (output.includes('invalid data found') || output.includes('moov atom not found') || output.includes('error opening input')) {
    return { code: 'input_video_invalid', message: '数字人视频无法被 ffmpeg 读取。' }
  }
  return { code: 'skill_failed', message: result.stderr.trim() || result.stdout.trim() || `ffmpeg 退出码：${result.exitCode}` }
}

function dimensionsForRatio(ratio: EditPlanV1['ratio']) {
  if (ratio === '1:1') return { width: 1080, height: 1080 }
  if (ratio === '16:9') return { width: 1280, height: 720 }
  return { width: 720, height: 1280 }
}

function subtitleForceStyle(style: EditPlanV1['subtitles']['style']) {
  if (style === 'bold') return 'FontName=Microsoft YaHei,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=70'
  if (style === 'cyan') return 'FontName=Microsoft YaHei,FontSize=22,Bold=1,PrimaryColour=&H00FFF000,OutlineColour=&H00202020,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'
  return 'FontName=Microsoft YaHei,FontSize=20,Bold=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00202020,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'
}

function escapeSubtitleFilterPath(filePath: string) {
  return path.resolve(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

function srtTime(value: number) {
  const totalMs = Math.max(0, Math.round(value * 1000))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const seconds = Math.floor((totalMs % 60000) / 1000)
  const milliseconds = totalMs % 1000
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(milliseconds, 3)}`
}

function pad(value: number, length: number) { return String(value).padStart(length, '0') }

function roundSeconds(value: number) {
  return Number(Math.max(0, value).toFixed(3))
}

function assertPostProductionPath(root: string, target: string) {
  try { return assertInsideRoot(root, target) } catch (error) {
    if (error instanceof WorkspaceGuardError) throw new VideoEditingSkillError('output_path_escape', '输出路径越过了当前 workspace。')
    throw error
  }
}

async function assertNonEmptyFile(filePath: string, code: string, message: string) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size <= 0) throw new VideoEditingSkillError(code, message)
  } catch (error) {
    if (error instanceof VideoEditingSkillError) throw error
    throw new VideoEditingSkillError(code, message)
  }
}

async function runProcess(input: VideoEditingProcessRunInput): Promise<VideoEditingProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, { windowsHide: true })
    let stdout = ''; let stderr = ''; let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killProcessTree(child.pid) }, input.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut }) })
    child.on('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }) })
  })
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); return }
  try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
}

async function probeDurationWithFfprobe(input: { outputPath: string; ffprobePath: string }) {
  const result = await runProcess({ command: input.ffprobePath, args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input.outputPath], timeoutMs: 30000 })
  if (result.exitCode !== 0 || result.timedOut) throw new VideoEditingSkillError('duration_probe_failed', result.stderr || 'ffprobe 读取时长失败。')
  return Number.parseFloat(result.stdout.trim())
}

function skillError(code: string, message: string): Extract<RunVideoEditingSkillResult, { status: 'skill_error' }> {
  return { status: 'skill_error', source: 'video_editing_skill', error: { code, message } }
}
