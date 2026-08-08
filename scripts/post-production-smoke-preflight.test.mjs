import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPostProductionSmokePreflight } from './post-production-smoke-preflight.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

describe('post-production smoke preflight', () => {
  it('skips unless local skill smoke is explicitly enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(runPostProductionSmokePreflight({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
  })

  it('rejects missing ffmpeg before running the local smoke', async () => {
    const root = makeTempRoot()
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runPostProductionSmokePreflight({
        env: {
          RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE: '1',
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
          POST_PRODUCTION_SMOKE_OUTPUT_ROOT: root,
        },
        logger,
        commandExists: (command) => command !== 'ffmpeg',
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'ffmpeg_missing',
    })
  })

  it('passes with ffmpeg, ffprobe and a writable output root', async () => {
    const root = makeTempRoot()
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runPostProductionSmokePreflight({
        env: {
          RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE: '1',
          FFMPEG_PATH: 'ffmpeg',
          FFPROBE_PATH: 'ffprobe',
          POST_PRODUCTION_SMOKE_OUTPUT_ROOT: root,
        },
        logger,
        commandExists: () => true,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      outputProbeRoot: root,
    })
  })

  it('rejects unwritable output roots before running the local skill smoke', async () => {
    const root = makeTempRoot()
    const outputRoot = path.join(root, 'not-a-directory')
    fs.writeFileSync(outputRoot, 'file blocks directory creation')
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runPostProductionSmokePreflight({
        env: {
          RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE: '1',
          POST_PRODUCTION_SMOKE_OUTPUT_ROOT: outputRoot,
        },
        logger,
        commandExists: () => true,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'output_not_writable',
    })
  })

  it('rejects template output roots before probing writability', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runPostProductionSmokePreflight({
        env: {
          RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE: '1',
          POST_PRODUCTION_SMOKE_OUTPUT_ROOT: 'C:\\path\\to\\post-production-output',
        },
        logger,
        commandExists: () => true,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'placeholder_output_root',
    })
  })
})

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-production-preflight-'))
  tempRoots.push(root)
  return root
}
