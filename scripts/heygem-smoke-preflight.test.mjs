import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHeyGemSmokePreflight } from './heygem-smoke-preflight.mjs'

const tempRoots = []
const duixEndpointOk = async () => ({ ok: true })

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

describe('HeyGem smoke preflight', () => {
  it('skips unless real runtime smoke is explicitly enabled', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(runHeyGemSmokePreflight({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
  })

  it('requires an API URL or script path when enabled', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_runtime',
    })
  })

  it('rejects invalid API URLs before checking audio', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'not-a-url',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_api_url',
    })
  })

  it('rejects placeholder Duix API URLs before checking reachability', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const checkApiReachable = vi.fn()

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          DUIX_AVATAR_API_URL: 'https://your-duix-avatar-backend.example.com',
        },
        logger,
        checkApiReachable,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_api_url',
    })
    expect(checkApiReachable).not.toHaveBeenCalled()
  })

  it('rejects placeholder Duix API keys before checking audio', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const checkApiReachable = vi.fn()

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
          DUIX_AVATAR_API_KEY: 'replace-with-duix-key',
        },
        logger,
        checkApiReachable,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'placeholder_api_key',
    })
    expect(checkApiReachable).not.toHaveBeenCalled()
  })

  it('requires an integration audio file after runtime is configured', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
        },
        logger,
        checkApiReachable: async () => true,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_audio',
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('HEYGEM_API_KEY is not set'))
  })

  it('passes with an API URL, readable audio and ffprobe', async () => {
    const root = makeTempRoot()
    const audioPath = path.join(root, 'audio.wav')
    fs.writeFileSync(audioPath, 'fake wav')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383/',
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        checkApiReachable: async () => true,
        probeAudioDuration: () => 8.2,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      apiUrl: 'http://127.0.0.1:8383',
      apiDialect: 'compatible_render',
      audioPath,
      audioDurationSeconds: 8.2,
    })
  })

  it('rejects unsupported API dialect values', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'unknown',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_api_dialect',
    })
  })

  it('rejects unreachable API URLs before running the integration smoke', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
        },
        logger,
        checkApiReachable: async () => false,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'api_unreachable',
    })
  })

  it('requires a result root for Duix face2face API mode', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_result_root',
    })
  })

  it('rejects Duix face2face API URLs that do not expose the easy query endpoint', async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const checkDuixFace2FaceEndpoint = vi.fn(async () => ({
      ok: false,
      reason: 'duix_endpoint_missing',
      messages: [
        'Duix face2face endpoint is not available at http://127.0.0.1:8383/easy/query.',
        'Point DUIX_AVATAR_API_URL to the Duix-Avatar service that exposes /easy/submit and /easy/query.',
      ],
    }))

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'duix_endpoint_missing',
    })
    expect(checkDuixFace2FaceEndpoint).toHaveBeenCalledWith('http://127.0.0.1:8383', {
      apiKey: undefined,
      timeoutMs: 3000,
    })
  })

  it('rejects invalid public asset base URLs for Duix face2face API mode', async () => {
    const root = makeTempRoot()
    const resultRoot = path.join(root, 'face2face-results')
    fs.mkdirSync(resultRoot, { recursive: true })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
          HEYGEM_PUBLIC_ASSET_BASE_URL: 'not-a-url',
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_public_asset_base_url',
    })
  })

  it('requires a video avatar asset for Duix face2face API mode', async () => {
    const root = makeTempRoot()
    const resultRoot = path.join(root, 'face2face-results')
    fs.mkdirSync(resultRoot, { recursive: true })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_avatar_asset',
    })
  })

  it('rejects non-video avatar assets for Duix face2face API mode', async () => {
    const root = makeTempRoot()
    const resultRoot = path.join(root, 'face2face-results')
    const avatarPath = path.join(root, 'avatar.png')
    fs.mkdirSync(resultRoot, { recursive: true })
    fs.writeFileSync(avatarPath, 'fake png')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
          HEYGEM_INTEGRATION_AVATAR_ASSET: avatarPath,
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_avatar_video',
    })
  })

  it('requires local Duix face2face assets under the host data root when no public URL is configured', async () => {
    const root = makeTempRoot()
    const hostRoot = path.join(root, 'host-data')
    const resultRoot = path.join(hostRoot, 'face2face-results')
    const audioPath = path.join(root, 'audio.wav')
    const avatarPath = path.join(hostRoot, 'avatar.mp4')
    fs.mkdirSync(resultRoot, { recursive: true })
    fs.writeFileSync(audioPath, 'fake wav')
    fs.writeFileSync(avatarPath, 'fake mp4')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
          HEYGEM_HOST_DATA_ROOT: hostRoot,
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          HEYGEM_INTEGRATION_AVATAR_ASSET: avatarPath,
        },
        logger,
        commandExists: () => true,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
        probeAudioDuration: () => 8.2,
        probeAvatarDuration: () => 5.4,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'asset_not_mounted',
    })
  })

  it('rejects Duix face2face avatar videos that ffprobe cannot read as positive duration', async () => {
    const root = makeTempRoot()
    const hostRoot = path.join(root, 'host-data')
    const resultRoot = path.join(hostRoot, 'face2face-results')
    const audioPath = path.join(hostRoot, 'audio.wav')
    const avatarPath = path.join(hostRoot, 'avatar.mp4')
    fs.mkdirSync(resultRoot, { recursive: true })
    fs.writeFileSync(audioPath, 'fake wav')
    fs.writeFileSync(avatarPath, 'broken mp4')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
          HEYGEM_HOST_DATA_ROOT: hostRoot,
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          HEYGEM_INTEGRATION_AVATAR_ASSET: avatarPath,
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
        probeAvatarDuration: () => 0,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'avatar_duration_probe_failed',
    })
  })

  it('rejects placeholder public asset base URLs for Duix face2face API mode', async () => {
    const root = makeTempRoot()
    const resultRoot = path.join(root, 'face2face-results')
    fs.mkdirSync(resultRoot, { recursive: true })
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
          DUIX_AVATAR_API_DIALECT: 'duix_face2face',
          DUIX_AVATAR_RESULT_ROOT: resultRoot,
          DUIX_AVATAR_PUBLIC_ASSET_BASE_URL: 'https://your-public-app-origin.example.com',
        },
        logger,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_public_asset_base_url',
    })
  })

  it('passes with Duix face2face API mode, result root, readable audio and ffprobe', async () => {
    const root = makeTempRoot()
    const hostRoot = path.join(root, 'host-data')
    const resultRoot = path.join(hostRoot, 'face2face-results')
    const audioPath = path.join(hostRoot, 'audio.wav')
    const avatarPath = path.join(hostRoot, 'avatar.mp4')
    fs.mkdirSync(resultRoot, { recursive: true })
    fs.writeFileSync(audioPath, 'fake wav')
    fs.writeFileSync(avatarPath, 'fake mp4')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383/',
          HEYGEM_API_DIALECT: 'duix_face2face',
          HEYGEM_RESULT_ROOT: resultRoot,
          HEYGEM_HOST_DATA_ROOT: hostRoot,
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          HEYGEM_INTEGRATION_AVATAR_ASSET: avatarPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
        probeAudioDuration: () => 8.2,
        probeAvatarDuration: () => 5.4,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      apiUrl: 'http://127.0.0.1:8383',
      apiDialect: 'duix_face2face',
      resultRoot,
      audioPath,
      audioDurationSeconds: 8.2,
    })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DUIX_AVATAR_PUBLIC_ASSET_BASE_URL'))
  })

  it('accepts Duix-Avatar environment aliases for the face2face runtime', async () => {
    const root = makeTempRoot()
    const hostRoot = path.join(root, 'host-data')
    const resultRoot = path.join(hostRoot, 'duix-results')
    const audioPath = path.join(hostRoot, 'audio.wav')
    const avatarPath = path.join(hostRoot, 'avatar.mp4')
    fs.mkdirSync(resultRoot, { recursive: true })
    fs.writeFileSync(audioPath, 'fake wav')
    fs.writeFileSync(avatarPath, 'fake mp4')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383/',
          DUIX_AVATAR_API_DIALECT: 'duix_face2face',
          DUIX_AVATAR_RESULT_ROOT: resultRoot,
          DUIX_AVATAR_HOST_DATA_ROOT: hostRoot,
          DUIX_AVATAR_INTEGRATION_AUDIO: audioPath,
          DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: avatarPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        checkApiReachable: async () => true,
        checkDuixFace2FaceEndpoint: duixEndpointOk,
        probeAudioDuration: () => 8.2,
        probeAvatarDuration: () => 5.4,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      apiUrl: 'http://127.0.0.1:8383',
      apiDialect: 'duix_face2face',
      resultRoot,
      audioPath,
    })
  })

  it('passes with a local script path and PowerShell available', async () => {
    const root = makeTempRoot()
    const audioPath = path.join(root, 'audio.wav')
    const scriptPath = path.join(root, 'Invoke-HeyGem.ps1')
    fs.writeFileSync(audioPath, 'fake wav')
    fs.writeFileSync(scriptPath, 'param()')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_SCRIPT_PATH: scriptPath,
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        probeAudioDuration: () => 8.2,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      scriptPath,
      audioPath,
      audioDurationSeconds: 8.2,
    })
  })

  it('rejects audio that ffprobe cannot read as positive duration', async () => {
    const root = makeTempRoot()
    const audioPath = path.join(root, 'audio.wav')
    fs.writeFileSync(audioPath, 'fake wav')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => true,
        checkApiReachable: async () => true,
        probeAudioDuration: () => 0,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'audio_duration_probe_failed',
    })
  })

  it('rejects missing ffprobe before running the integration smoke', async () => {
    const root = makeTempRoot()
    const audioPath = path.join(root, 'audio.wav')
    fs.writeFileSync(audioPath, 'fake wav')
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      runHeyGemSmokePreflight({
        env: {
          RUN_HEYGEM_INTEGRATION: '1',
          HEYGEM_API_URL: 'http://127.0.0.1:8383',
          HEYGEM_INTEGRATION_AUDIO: audioPath,
          FFPROBE_PATH: 'ffprobe',
        },
        logger,
        commandExists: () => false,
        checkApiReachable: async () => true,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'ffprobe_missing',
    })
  })
})

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heygem-preflight-'))
  tempRoots.push(root)
  return root
}
