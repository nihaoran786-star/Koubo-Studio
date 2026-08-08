import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runIndexTTS2SmokePreflight } from './indextts2-smoke-preflight.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

describe('IndexTTS2 smoke preflight', () => {
  it('skips unless the real runtime smoke is explicitly enabled', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(runIndexTTS2SmokePreflight({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
  })

  it('requires a reference audio path when enabled', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_reference_audio',
    })
  })

  it('requires a runtime root after reference audio is present', async () => {
    const root = makeTempRoot()
    const referenceAudio = path.join(root, 'reference.wav')
    fs.writeFileSync(referenceAudio, 'fake wav')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_runtime_root',
    })
  })

  it('rejects template reference audio paths before touching the filesystem', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_REFERENCE_AUDIO: 'C:\\path\\to\\reference.wav',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'placeholder_reference_audio',
    })
  })

  it('rejects template runtime roots before runtime layout checks', async () => {
    const root = makeTempRoot()
    const referenceAudio = path.join(root, 'reference.wav')
    fs.writeFileSync(referenceAudio, 'fake wav')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_RUNTIME_ROOT: 'C:\\path\\to\\indextts2-runtime',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'placeholder_runtime_root',
    })
  })

  it('rejects template wrapper paths before wrapper inspection', async () => {
    const root = makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const referenceAudio = path.join(root, 'reference.wav')
    seedRuntimeLayout({
      runtimeRoot,
      referenceAudio,
      scriptPath: path.join(root, 'skills', 'Invoke-NaturalTTS.ps1'),
    })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_SCRIPT_PATH: 'C:\\path\\to\\Invoke-NaturalTTS.ps1',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'placeholder_script_path',
    })
  })

  it('passes with a complete local runtime layout and available ffmpeg tools', async () => {
    const root = makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const referenceAudio = path.join(root, 'reference.wav')
    const scriptPath = path.join(root, 'skills', 'Invoke-NaturalTTS.ps1')
    seedRuntimeLayout({ runtimeRoot, referenceAudio, scriptPath })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_SCRIPT_PATH: scriptPath,
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        probeAudioDuration: () => 10,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      runtimeRoot,
      scriptPath,
      referenceAudioPath: referenceAudio,
      referenceDurationSeconds: 10,
    })
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('No obvious model weight file'))
  })

  it('rejects a wrapper that does not accept the app adapter parameters', async () => {
    const root = makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const referenceAudio = path.join(root, 'reference.wav')
    const scriptPath = path.join(root, 'skills', 'Invoke-NaturalTTS.ps1')
    seedRuntimeLayout({ runtimeRoot, referenceAudio, scriptPath })
    fs.writeFileSync(scriptPath, 'param([string]$ReferenceAudio)')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_SCRIPT_PATH: scriptPath,
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        probeAudioDuration: () => 10,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'wrapper_parameter_mismatch',
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Text, Output, OutputFormat, RuntimeRoot'))
  })

  it('rejects reference audio outside the 8-12 second range', async () => {
    const root = makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const referenceAudio = path.join(root, 'reference.wav')
    const scriptPath = path.join(root, 'skills', 'Invoke-NaturalTTS.ps1')
    seedRuntimeLayout({ runtimeRoot, referenceAudio, scriptPath })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_SCRIPT_PATH: scriptPath,
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        probeAudioDuration: () => 4,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'reference_audio_duration_out_of_range',
    })
  })

  it('rejects missing ffmpeg before touching the runtime smoke', async () => {
    const root = makeTempRoot()
    const runtimeRoot = path.join(root, 'runtime')
    const referenceAudio = path.join(root, 'reference.wav')
    const scriptPath = path.join(root, 'skills', 'Invoke-NaturalTTS.ps1')
    seedRuntimeLayout({ runtimeRoot, referenceAudio, scriptPath })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runIndexTTS2SmokePreflight({
        env: {
          RUN_INDEXTTS2_INTEGRATION: '1',
          INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
          INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
          INDEXTTS2_SCRIPT_PATH: scriptPath,
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: (command) => command !== 'ffmpeg',
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'ffmpeg_missing',
    })
  })
})

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indextts2-preflight-'))
  tempRoots.push(root)
  return root
}

function seedRuntimeLayout({ runtimeRoot, referenceAudio, scriptPath }) {
  const indexRoot = path.join(runtimeRoot, 'IndexTTS')
  fs.mkdirSync(path.join(indexRoot, '.venv', 'Scripts'), { recursive: true })
  fs.mkdirSync(path.join(indexRoot, 'checkpoints'), { recursive: true })
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(referenceAudio, 'fake wav')
  fs.writeFileSync(path.join(indexRoot, '.venv', 'Scripts', 'python.exe'), 'fake python')
  fs.writeFileSync(path.join(indexRoot, 'checkpoints', 'config.yaml'), 'fake: config')
  fs.writeFileSync(path.join(indexRoot, 'checkpoints', 'gpt.pth'), 'fake weights')
  fs.writeFileSync(scriptPath, makeCompatibleWrapperParamBlock())
  fs.writeFileSync(path.join(path.dirname(scriptPath), 'natural_tts.py'), 'print("fake")')
}

function makeCompatibleWrapperParamBlock() {
  return `
param(
  [string]$ReferenceAudio,
  [string]$Text,
  [string]$Output,
  [string]$OutputFormat,
  [string]$RuntimeRoot,
  [string]$EmotionText,
  [double]$EmotionAlpha,
  [double]$Speed,
  [string]$EmotionReferenceAudio,
  [Nullable[int]]$Seed,
  [bool]$UseRandom,
  [double]$TrimSeconds
)
`
}
