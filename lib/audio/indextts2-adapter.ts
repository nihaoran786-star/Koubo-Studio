import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import {
  resolveLocalRuntimeConfig,
  type LocalIndexTTS2RuntimeConfig,
} from '@/lib/runtime-data/runtime-config-store'
import type { VoiceGenerationParameters } from './voice-generation'

export type IndexTTS2AdapterResult =
  | {
      status: 'ok'
      source: 'indextts2'
      outputPath: string
      durationSeconds: number
    }
  | {
      status: 'adapter_error'
      source: 'indextts2'
      error: {
        code: string
        message: string
      }
    }

export interface IndexTTS2AdapterInput {
  projectId: string
  workspacePath: string
  parameters: VoiceGenerationParameters
  outputPath: string
}

export type IndexTTS2RuntimeConfig = LocalIndexTTS2RuntimeConfig

export interface IndexTTS2ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface IndexTTS2ProcessRunInput {
  command: string
  args: string[]
  timeoutMs: number
}

export type IndexTTS2ProcessRunner = (input: IndexTTS2ProcessRunInput) => Promise<IndexTTS2ProcessResult>
export type ProbeDuration = (input: { outputPath: string; ffprobePath: string }) => Promise<number>

export type RunIndexTTS2Adapter = (
  input: IndexTTS2AdapterInput,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    runtimeConfigRoot?: string
    developmentRoot?: string
    resolveRuntimeConfig?: () => Promise<IndexTTS2RuntimeConfig | undefined>
    runner?: IndexTTS2ProcessRunner
    probeDuration?: ProbeDuration
  },
) => Promise<IndexTTS2AdapterResult>

export class IndexTTS2AdapterError extends Error {
  source = 'indextts2' as const

  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IndexTTS2AdapterError'
  }
}

export function readIndexTTS2RuntimeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IndexTTS2RuntimeConfig | undefined {
  const runtimeRoot = env.INDEXTTS2_RUNTIME_ROOT?.trim()
  const scriptPath =
    env.INDEXTTS2_SCRIPT_PATH?.trim() ||
    path.resolve(process.cwd(), '..', 'skills', 'natural-tts-voice-cloning', 'scripts', 'Invoke-NaturalTTS.ps1')

  if (!runtimeRoot) return undefined

  return {
    runtimeRoot,
    scriptPath,
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    timeoutMs: Number(env.INDEXTTS2_TIMEOUT_MS) > 0 ? Number(env.INDEXTTS2_TIMEOUT_MS) : 180000,
  }
}

export function buildIndexTTS2PowerShellArgs(input: {
  scriptPath: string
  runtimeRoot: string
  input: IndexTTS2AdapterInput
}) {
  const parameters = input.input.parameters
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    input.scriptPath,
    '-ReferenceAudio',
    parameters.referenceAudioPath ?? '',
    '-Text',
    parameters.text,
    '-Output',
    input.input.outputPath,
    '-OutputFormat',
    parameters.outputFormat,
    '-RuntimeRoot',
    input.runtimeRoot,
    '-EmotionText',
    parameters.emotionText ?? '',
    '-EmotionAlpha',
    String(parameters.emotionAlpha),
    '-Speed',
    String(parameters.speed),
    '-EmotionReferenceAudio',
    parameters.emotionReferenceAudioPath ?? '',
  ]

  if (!parameters.useRandom && typeof parameters.seed === 'number') {
    args.push('-Seed', String(parameters.seed))
  }

  args.push('-UseRandom', parameters.useRandom ? '1' : '0')

  if (typeof parameters.trimSeconds === 'number') {
    args.push('-TrimSeconds', String(parameters.trimSeconds))
  }

  return args
}

export function classifyIndexTTS2ProcessError(result: IndexTTS2ProcessResult) {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.timedOut) {
    return {
      code: 'runtime_timeout',
      message: 'IndexTTS2 生成超时，请检查模型是否卡住或输入是否过长。',
    }
  }
  if (output.includes('runtime not found') || output.includes('expected python')) {
    return {
      code: 'runtime_missing',
      message: 'IndexTTS2 runtime 未找到，请检查本地模型路径和 Python 环境。',
    }
  }
  if (output.includes('error opening input stream') && output.includes('wetext\\fsts')) {
    return {
      code: 'runtime_path_encoding_error',
      message: 'IndexTTS2 文本规范化资源加载失败。请把 runtime 放到纯 ASCII 路径，避免 wetext/kaldifst 在中文路径下无法读取 FST 文件。',
    }
  }
  if (
    output.includes('ffmpeg is required') ||
    output.includes('ffprobe is required') ||
    output.includes('was not found on path') ||
    output.includes('not recognized as') ||
    output.includes('the term') && (output.includes('ffmpeg') || output.includes('ffprobe'))
  ) {
    return {
      code: 'dependency_missing',
      message: '音频依赖缺失，请确认 ffmpeg/ffprobe 已安装并在 PATH 中。',
    }
  }
  if (
    output.includes('missing indextts2 config') ||
    output.includes('model weights missing') ||
    output.includes('no such file or directory') && (
      output.includes('gpt.pth') ||
      output.includes('s2mel.pth') ||
      output.includes('bpe.model') ||
      output.includes('checkpoints')
    )
  ) {
    return {
      code: 'model_weights_missing',
      message: 'IndexTTS2 模型权重缺失，请检查 checkpoints 目录。',
    }
  }
  return {
    code: 'runtime_failed',
    message: result.stderr.trim() || result.stdout.trim() || `IndexTTS2 进程退出码：${result.exitCode}`,
  }
}

export async function verifyIndexTTS2Output(input: {
  workspacePath: string
  outputPath: string
  ffprobePath?: string
  probeDuration: ProbeDuration
}) {
  const audioRoot = path.join(input.workspacePath, 'artifacts', 'audio')
  let outputPath: string
  try {
    outputPath = assertInsideRoot(audioRoot, input.outputPath)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new IndexTTS2AdapterError('output_path_escape', '输出路径越过了当前 workspace audio artifact 目录。')
    }
    throw error
  }

  try {
    const stat = await fs.stat(outputPath)
    if (!stat.isFile() || stat.size <= 0) {
      throw new IndexTTS2AdapterError('output_missing', 'IndexTTS2 没有生成有效音频文件。')
    }
  } catch (error) {
    if (error instanceof IndexTTS2AdapterError) throw error
    throw new IndexTTS2AdapterError('output_missing', 'IndexTTS2 没有生成音频文件。')
  }

  const durationSeconds = await input.probeDuration({
    outputPath,
    ffprobePath: input.ffprobePath ?? 'ffprobe',
  })

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new IndexTTS2AdapterError('invalid_duration', '生成音频时长无效。')
  }

  return {
    outputPath,
    durationSeconds,
  }
}

export const runIndexTTS2Adapter: RunIndexTTS2Adapter = async (input, options = {}) => {
  try {
    const config = options.resolveRuntimeConfig
      ? await options.resolveRuntimeConfig()
      : await resolveIndexTTS2RuntimeConfig({
          env: options.env,
          root: options.runtimeConfigRoot,
          developmentRoot: options.developmentRoot,
        })
    if (!config) {
      return adapterError('runtime_missing', 'IndexTTS2 runtime 尚未配置。请设置 INDEXTTS2_RUNTIME_ROOT。')
    }

    await fs.access(config.scriptPath)

    const processResult = await (options.runner ?? runProcess)({
      command: 'powershell',
      args: buildIndexTTS2PowerShellArgs({
        scriptPath: config.scriptPath,
        runtimeRoot: config.runtimeRoot,
        input,
      }),
      timeoutMs: config.timeoutMs,
    })

    if (processResult.exitCode !== 0 || processResult.timedOut) {
      const error = classifyIndexTTS2ProcessError(processResult)
      return adapterError(error.code, error.message)
    }

    const output = await verifyIndexTTS2Output({
      workspacePath: input.workspacePath,
      outputPath: input.outputPath,
      ffprobePath: config.ffprobePath,
      probeDuration: options.probeDuration ?? probeDurationWithFfprobe,
    })

    return {
      status: 'ok',
      source: 'indextts2',
      outputPath: output.outputPath,
      durationSeconds: output.durationSeconds,
    }
  } catch (error) {
    if (error instanceof IndexTTS2AdapterError) {
      return adapterError(error.code, error.message)
    }
    if (isMissingPathError(error)) {
      return adapterError('runtime_missing', 'IndexTTS2 启动脚本或 runtime 路径不存在。')
    }
    const message = error instanceof Error ? error.message : String(error)
    return adapterError('runtime_failed', message)
  }
}

async function resolveIndexTTS2RuntimeConfig(options: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  root?: string
  developmentRoot?: string
}) {
  const config = await resolveLocalRuntimeConfig({
    root: options.root,
    developmentRoot: options.developmentRoot,
    injectedEnv: options.env,
    isolateInjectedEnv: options.env !== undefined,
  })
  return config.indextts2.runtimeRoot ? config.indextts2 : undefined
}

function adapterError(code: string, message: string): Extract<IndexTTS2AdapterResult, { status: 'adapter_error' }> {
  return {
    status: 'adapter_error',
    source: 'indextts2',
    error: {
      code,
      message,
    },
  }
}

async function runProcess(input: IndexTTS2ProcessRunInput): Promise<IndexTTS2ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid)
    }, input.timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
      })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => {
      // Fall back to the direct child if taskkill is unavailable.
      try {
        process.kill(pid)
      } catch {
        // Process may already be gone.
      }
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Process may already be gone.
  }
}

async function probeDurationWithFfprobe(input: { outputPath: string; ffprobePath: string }) {
  const result = await runProcess({
    command: input.ffprobePath,
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', input.outputPath],
    timeoutMs: 30000,
  })

  if (result.exitCode !== 0 || result.timedOut) {
    throw new IndexTTS2AdapterError('duration_probe_failed', result.stderr || 'ffprobe 读取音频时长失败。')
  }

  return Number.parseFloat(result.stdout.trim())
}

function isMissingPathError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
