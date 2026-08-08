import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildIndexTTS2PowerShellArgs,
  classifyIndexTTS2ProcessError,
  readIndexTTS2RuntimeConfig,
  runIndexTTS2Adapter,
  verifyIndexTTS2Output,
  type IndexTTS2ProcessRunner,
} from './indextts2-adapter'

const tmpRoots: string[] = []

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
  tmpRoots.length = 0
})

describe('IndexTTS2 adapter', () => {
  it('reads runtime config from environment variables', () => {
    const config = readIndexTTS2RuntimeConfig({
      INDEXTTS2_RUNTIME_ROOT: 'C:\\codex-indextts-test',
      INDEXTTS2_SCRIPT_PATH: 'C:\\skills\\natural-tts\\Invoke-NaturalTTS.ps1',
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
    })

    expect(config).toEqual({
      runtimeRoot: 'C:\\codex-indextts-test',
      scriptPath: 'C:\\skills\\natural-tts\\Invoke-NaturalTTS.ps1',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      timeoutMs: 180000,
    })
  })

  it('builds PowerShell arguments with voice and emotion parameters', () => {
    const args = buildIndexTTS2PowerShellArgs({
      scriptPath: 'C:\\skills\\Invoke-NaturalTTS.ps1',
      runtimeRoot: 'C:\\codex-indextts-test',
      input: {
        projectId: 'demo',
        workspacePath: 'C:\\workspace',
        outputPath: 'C:\\workspace\\artifacts\\audio\\a.wav',
        parameters: {
          text: '测试音频',
          referenceAudioPath: 'C:\\ref.wav',
          speed: 1.25,
          emotionText: '自然清晰',
          emotionAlpha: 0.35,
          emotionReferenceAudioPath: 'C:\\emotion.wav',
          seed: 7,
          trimSeconds: 10,
          useRandom: false,
          outputFormat: 'wav',
        },
      },
    })

    expect(args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\skills\\Invoke-NaturalTTS.ps1',
      '-ReferenceAudio',
      'C:\\ref.wav',
      '-Text',
      '测试音频',
      '-Output',
      'C:\\workspace\\artifacts\\audio\\a.wav',
      '-OutputFormat',
      'wav',
      '-RuntimeRoot',
      'C:\\codex-indextts-test',
      '-EmotionText',
      '自然清晰',
      '-EmotionAlpha',
      '0.35',
      '-Speed',
      '1.25',
      '-EmotionReferenceAudio',
      'C:\\emotion.wav',
      '-Seed',
      '7',
      '-UseRandom',
      '0',
      '-TrimSeconds',
      '10',
    ])
  })

  it('does not pass a fixed seed when random generation is enabled', () => {
    const args = buildIndexTTS2PowerShellArgs({
      scriptPath: 'C:\\skills\\Invoke-NaturalTTS.ps1',
      runtimeRoot: 'C:\\codex-indextts-test',
      input: {
        projectId: 'demo',
        workspacePath: 'C:\\workspace',
        outputPath: 'C:\\workspace\\artifacts\\audio\\a.wav',
        parameters: {
          text: '测试音频',
          referenceAudioPath: 'C:\\ref.wav',
          speed: 1,
          emotionAlpha: 0.2,
          seed: 7,
          useRandom: true,
          outputFormat: 'wav',
        },
      },
    })

    expect(args).not.toContain('-Seed')
    expect(args).toContain('-UseRandom')
    expect(args[args.indexOf('-UseRandom') + 1]).toBe('1')
  })

  it('classifies process errors into typed adapter errors', () => {
    expect(classifyIndexTTS2ProcessError({ exitCode: null, timedOut: true, stdout: '', stderr: '' })).toMatchObject({
      code: 'runtime_timeout',
    })
    expect(
      classifyIndexTTS2ProcessError({
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'IndexTTS2 runtime not found. Expected Python at: C:\\x\\python.exe',
      }),
    ).toMatchObject({
      code: 'runtime_missing',
    })
    expect(
      classifyIndexTTS2ProcessError({
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'ffmpeg is required but was not found on PATH',
      }),
    ).toMatchObject({
      code: 'dependency_missing',
    })
    expect(
      classifyIndexTTS2ProcessError({
        exitCode: 1,
        timedOut: false,
        stdout: 'ffmpeg version 8.1',
        stderr:
          "RuntimeError: Error opening input stream 'C:\\Users\\demo\\应聘\\IndexTTS\\.venv\\lib\\site-packages\\wetext\\fsts\\traditional_to_simple.fst'",
      }),
    ).toMatchObject({
      code: 'runtime_path_encoding_error',
    })
    expect(
      classifyIndexTTS2ProcessError({
        exitCode: 1,
        timedOut: false,
        stdout: '>> GPT weights restored from: C:\\runtime\\IndexTTS\\checkpoints\\gpt.pth',
        stderr: 'RuntimeError: unrelated inference error',
      }),
    ).toMatchObject({
      code: 'runtime_failed',
    })
  })

  it('verifies generated output is inside workspace audio artifacts and has duration', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-indextts2-output-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'audio', 'sample.wav')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'fake wav')

    const result = await verifyIndexTTS2Output({
      workspacePath: root,
      outputPath,
      probeDuration: async () => 3.25,
    })

    expect(result).toEqual({
      outputPath: path.resolve(outputPath),
      durationSeconds: 3.25,
    })
  })

  it('rejects output paths outside the workspace audio artifact directory', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-indextts2-output-'))
    tmpRoots.push(root)
    const outside = path.join(path.dirname(root), 'outside.wav')

    await expect(
      verifyIndexTTS2Output({
        workspacePath: root,
        outputPath: outside,
        probeDuration: async () => 1,
      }),
    ).rejects.toMatchObject({
      code: 'output_path_escape',
    })
  })

  it('runs the PowerShell adapter and returns verified output duration', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-indextts2-run-'))
    tmpRoots.push(root)
    const scriptPath = path.join(root, 'Invoke-NaturalTTS.ps1')
    const outputPath = path.join(root, 'artifacts', 'audio', 'sample.wav')
    await fs.writeFile(scriptPath, 'param()')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const runner = vi.fn<IndexTTS2ProcessRunner>(async () => {
      await fs.writeFile(outputPath, 'fake wav')
      return { exitCode: 0, stdout: 'Generated', stderr: '', timedOut: false }
    })

    const result = await runIndexTTS2Adapter(
      {
        projectId: 'demo',
        workspacePath: root,
        outputPath,
        parameters: {
          text: '测试音频',
          referenceAudioPath: 'C:\\ref.wav',
          speed: 1,
          emotionAlpha: 0.2,
          useRandom: false,
          outputFormat: 'wav',
        },
      },
      {
        env: {
          INDEXTTS2_RUNTIME_ROOT: root,
          INDEXTTS2_SCRIPT_PATH: scriptPath,
        },
        runner,
        probeDuration: async () => 2.5,
      },
    )

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 2.5,
    })
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'powershell',
        timeoutMs: 180000,
      }),
    )
  })

  it('每次生成都重新解析 runtime 配置', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-indextts2-resolve-'))
    tmpRoots.push(root)
    const firstScript = path.join(root, 'first.ps1')
    const secondScript = path.join(root, 'second.ps1')
    const outputPath = path.join(root, 'artifacts', 'audio', 'sample.wav')
    await fs.writeFile(firstScript, 'param()')
    await fs.writeFile(secondScript, 'param()')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const runner = vi.fn<IndexTTS2ProcessRunner>(async () => {
      await fs.writeFile(outputPath, 'fake wav')
      return { exitCode: 0, stdout: 'Generated', stderr: '', timedOut: false }
    })
    const configs = [firstScript, secondScript]
    const resolveRuntimeConfig = vi.fn(async () => ({
      runtimeRoot: root,
      scriptPath: configs.shift()!,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      timeoutMs: 180000,
    }))
    const input = {
      projectId: 'demo',
      workspacePath: root,
      outputPath,
      parameters: {
        text: '测试音频',
        referenceAudioPath: 'C:\\ref.wav',
        speed: 1,
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav' as const,
      },
    }

    await runIndexTTS2Adapter(input, { resolveRuntimeConfig, runner, probeDuration: async () => 1 })
    await runIndexTTS2Adapter(input, { resolveRuntimeConfig, runner, probeDuration: async () => 1 })

    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0][0].args).toContain(firstScript)
    expect(runner.mock.calls[1][0].args).toContain(secondScript)
  })
})
