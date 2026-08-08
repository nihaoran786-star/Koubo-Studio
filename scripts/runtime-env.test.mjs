import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRuntimeEnvFiles, parseRuntimeEnvFile } from './runtime-env.mjs'

describe('runtime env loader', () => {
  it('parses dotenv-like key value files', () => {
    expect(parseRuntimeEnvFile(`
      # comment
      RUN_HEYGEM_INTEGRATION=1
      HEYGEM_API_URL="http://127.0.0.1:8383"
      BROWSER_PUBLISH_PLATFORM='douyin'
      FFMPEG_PATH=ffmpeg # inline comment
    `)).toEqual({
      RUN_HEYGEM_INTEGRATION: '1',
      HEYGEM_API_URL: 'http://127.0.0.1:8383',
      BROWSER_PUBLISH_PLATFORM: 'douyin',
      FFMPEG_PATH: 'ffmpeg',
    })
  })

  it('loads runtime env files while preserving shell overrides', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-env-'))
    try {
      writeFileSync(path.join(temp, '.env.local'), 'RUN_MODEL_PROVIDER_SMOKE=1\nMODEL_PROVIDER_SMOKE_MODEL=file-model\n')
      writeFileSync(path.join(temp, '.env.runtime.local'), 'MODEL_PROVIDER_SMOKE_MODEL=runtime-model\n')

      const result = loadRuntimeEnvFiles({
        cwd: temp,
        env: {
          MODEL_PROVIDER_SMOKE_MODEL: 'shell-model',
        },
      })

      expect(result.env.RUN_MODEL_PROVIDER_SMOKE).toBe('1')
      expect(result.env.MODEL_PROVIDER_SMOKE_MODEL).toBe('shell-model')
      expect(result.loadedFiles).toHaveLength(2)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('supports explicit RUNTIME_ENV_FILE lists', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'runtime-env-'))
    try {
      mkdirSync(path.join(temp, 'config'))
      const first = path.join(temp, 'config', 'first.env')
      const second = path.join(temp, 'config', 'second.env')
      writeFileSync(first, 'RUN_BROWSER_PUBLISH_PREPARE=1\nBROWSER_PUBLISH_PLATFORM=douyin\n')
      writeFileSync(second, 'BROWSER_PUBLISH_PLATFORM=xiaohongshu\n')

      const result = loadRuntimeEnvFiles({
        cwd: temp,
        env: {
          RUNTIME_ENV_FILE: `config/first.env${path.delimiter}config/second.env`,
        },
      })

      expect(result.env.RUN_BROWSER_PUBLISH_PREPARE).toBe('1')
      expect(result.env.BROWSER_PUBLISH_PLATFORM).toBe('xiaohongshu')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
