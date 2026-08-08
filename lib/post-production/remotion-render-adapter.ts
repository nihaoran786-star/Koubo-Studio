import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EditPlanV1 } from './edit-plan'
import type {
  VideoEditingProcessResult,
  VideoEditingProcessRunner,
} from './video-editing-skill-runner'

export interface RemotionRenderInput {
  postProductionRoot: string
  inputPath: string
  outputPath: string
  durationSeconds: number
  scriptText: string
  plan: EditPlanV1
  runner: VideoEditingProcessRunner
  timeoutMs: number
}

export type RemotionRenderResult =
  | { status: 'ok'; source: 'remotion_render_adapter' }
  | {
      status: 'failed'
      source: 'remotion_render_adapter'
      error: { code: string; message: string }
    }

export async function renderRemotionEnhancement(
  input: RemotionRenderInput,
): Promise<RemotionRenderResult> {
  if (input.plan.ratio !== '9:16') {
    return failed('unsupported_ratio', 'Remotion 增强渲染首版只支持 9:16。')
  }
  const stagingDirectory = path.join(
    input.postProductionRoot,
    `.remotion-${randomUUID()}`,
  )
  const manifestPath = path.join(stagingDirectory, 'render.json')
  try {
    await fs.mkdir(stagingDirectory, { recursive: false })
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        inputPath: input.inputPath,
        outputLocation: input.outputPath,
        concurrency: 2,
        props: {
          durationSeconds: input.durationSeconds,
          scriptText: input.scriptText,
          subtitleStyle: input.plan.subtitles.style,
          maxCharsPerCue: input.plan.subtitles.maxCharsPerCue,
          creative: input.plan.creative,
        },
      })}\n`,
      'utf8',
    )
    const workerPath = path.resolve(
      process.cwd(),
      'scripts',
      'remotion-render-worker.mjs',
    )
    const result = await input.runner({
      command: process.execPath,
      args: [workerPath, manifestPath],
      timeoutMs: Math.max(input.timeoutMs, 600_000),
    })
    return classifyRemotionResult(result)
  } catch (error) {
    return failed(
      'remotion_render_failed',
      error instanceof Error ? error.message : 'Remotion 增强渲染失败。',
    )
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

function classifyRemotionResult(result: VideoEditingProcessResult): RemotionRenderResult {
  if (result.timedOut) {
    return failed('remotion_render_timeout', 'Remotion 增强渲染超时。')
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    return failed(
      'remotion_render_failed',
      detail || `Remotion 渲染进程退出码：${result.exitCode}`,
    )
  }
  return { status: 'ok', source: 'remotion_render_adapter' }
}

function failed(code: string, message: string): Extract<RemotionRenderResult, { status: 'failed' }> {
  return {
    status: 'failed',
    source: 'remotion_render_adapter',
    error: { code, message },
  }
}
