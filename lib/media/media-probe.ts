import { spawn } from 'node:child_process'

export type MediaProbeResult =
  | {
      status: 'ok'
      durationSeconds: number
    }
  | {
      status: 'failed'
      error: {
        code: 'media_probe_failed' | 'media_duration_invalid'
        message: string
      }
    }

export type ProbeMediaDuration = (input: {
  filePath: string
  ffprobePath?: string
}) => Promise<MediaProbeResult>

export const probeMediaDuration: ProbeMediaDuration = async ({ filePath, ffprobePath }) => {
  const command = ffprobePath?.trim() || process.env.FFPROBE_PATH?.trim() || 'ffprobe'
  const result = await runFfprobe(command, filePath)
  if (result.status !== 'ok') return result
  if (!Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
    return {
      status: 'failed',
      error: {
        code: 'media_duration_invalid',
        message: '媒体文件无法读出有效时长。',
      },
    }
  }
  return result
}

function runFfprobe(command: string, filePath: string): Promise<MediaProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], {
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      resolve({
        status: 'failed',
        error: {
          code: 'media_probe_failed',
          message: error.message,
        },
      })
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({
          status: 'failed',
          error: {
            code: 'media_probe_failed',
            message: stderr.trim() || `ffprobe exited with ${code ?? 1}`,
          },
        })
        return
      }
      const durationSeconds = Number(stdout.trim())
      resolve({
        status: 'ok',
        durationSeconds,
      })
    })
  })
}
