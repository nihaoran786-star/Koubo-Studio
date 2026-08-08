import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDigitalHumanChainSmokePreflight } from './digital-human-chain-smoke-preflight.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  tempRoots.length = 0
})

describe('digital-human chain smoke preflight', () => {
  it('skips unless the chain smoke is explicitly enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(runDigitalHumanChainSmokePreflight({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
  })

  it('reports missing IndexTTS2 and HeyGem/Duix chain config together', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env: {
          RUN_DIGITAL_HUMAN_CHAIN_SMOKE: '1',
        },
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_chain_runtime_config',
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('INDEXTTS2_REFERENCE_AUDIO'))
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DUIX_AVATAR_API_URL or DUIX_AVATAR_SCRIPT_PATH'))
  })

  it('requires an avatar asset for Duix face2face chain smoke', async () => {
    const root = makeTempRoot()
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      DUIX_AVATAR_RESULT_ROOT: path.join(root, 'duix-results'),
    })
    fs.mkdirSync(env.DUIX_AVATAR_RESULT_ROOT, { recursive: true })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_chain_runtime_config',
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DUIX_AVATAR_INTEGRATION_AVATAR_ASSET'))
  })

  it('rejects still-image avatar assets for Duix face2face chain smoke', async () => {
    const root = makeTempRoot()
    const avatarAsset = path.join(root, 'avatar.jpg')
    fs.writeFileSync(avatarAsset, 'fake image')
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      DUIX_AVATAR_RESULT_ROOT: path.join(root, 'duix-results'),
      DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: avatarAsset,
    })
    fs.mkdirSync(env.DUIX_AVATAR_RESULT_ROOT, { recursive: true })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_avatar_video',
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('must be a video file'))
  })

  it('requires the workspace root to be inside the Duix host data root when using local file mapping', async () => {
    const root = makeTempRoot()
    const avatarAsset = path.join(root, 'avatar.mp4')
    fs.writeFileSync(avatarAsset, 'fake avatar')
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      DUIX_AVATAR_RESULT_ROOT: path.join(root, 'duix-results'),
      DUIX_AVATAR_HOST_DATA_ROOT: path.join(root, 'host-data'),
      DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: avatarAsset,
    })
    fs.mkdirSync(env.DUIX_AVATAR_RESULT_ROOT, { recursive: true })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'missing_chain_runtime_config',
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('KOUBO_WORKSPACES_ROOT'))
  })

  it('rejects workspace roots outside the Duix host data root', async () => {
    const root = makeTempRoot()
    const avatarAsset = path.join(root, 'avatar.mp4')
    const hostDataRoot = path.join(root, 'host-data')
    const workspacesRoot = path.join(root, 'outside-workspaces')
    fs.writeFileSync(avatarAsset, 'fake avatar')
    fs.mkdirSync(path.join(root, 'duix-results'), { recursive: true })
    fs.mkdirSync(hostDataRoot, { recursive: true })
    fs.mkdirSync(workspacesRoot, { recursive: true })
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      DUIX_AVATAR_RESULT_ROOT: path.join(root, 'duix-results'),
      DUIX_AVATAR_HOST_DATA_ROOT: hostDataRoot,
      DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: avatarAsset,
      KOUBO_WORKSPACES_ROOT: workspacesRoot,
    })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'workspace_root_not_mounted',
    })
  })

  it('passes with complete Duix face2face chain config and readable files', async () => {
    const root = makeTempRoot()
    const avatarAsset = path.join(root, 'avatar.mp4')
    fs.writeFileSync(avatarAsset, 'fake avatar')
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      DUIX_AVATAR_RESULT_ROOT: path.join(root, 'duix-results'),
      DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: avatarAsset,
    })
    fs.mkdirSync(env.DUIX_AVATAR_RESULT_ROOT, { recursive: true })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      referenceAudioPath: env.INDEXTTS2_REFERENCE_AUDIO,
      runtimeRoot: env.INDEXTTS2_RUNTIME_ROOT,
      apiUrl: env.DUIX_AVATAR_API_URL,
      apiDialect: 'duix_face2face',
      resultRoot: env.DUIX_AVATAR_RESULT_ROOT,
      avatarAsset,
    })
  })

  it('passes with compatible_render chain config without an avatar asset', async () => {
    const root = makeTempRoot()
    const env = seedChainEnv(root, {
      DUIX_AVATAR_API_DIALECT: 'compatible_render',
    })
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDigitalHumanChainSmokePreflight({
        env,
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      apiDialect: 'compatible_render',
    })
  })
})

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-human-chain-preflight-'))
  tempRoots.push(root)
  return root
}

function seedChainEnv(root, overrides = {}) {
  const runtimeRoot = path.join(root, 'runtime')
  const indexRoot = path.join(runtimeRoot, 'IndexTTS')
  const referenceAudio = path.join(root, 'reference.wav')
  const scriptPath = path.join(root, 'skills', 'Invoke-NaturalTTS.ps1')
  fs.mkdirSync(path.join(indexRoot, '.venv', 'Scripts'), { recursive: true })
  fs.mkdirSync(path.join(indexRoot, 'checkpoints'), { recursive: true })
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(referenceAudio, 'fake reference')
  fs.writeFileSync(scriptPath, 'param()')
  return {
    RUN_DIGITAL_HUMAN_CHAIN_SMOKE: '1',
    INDEXTTS2_RUNTIME_ROOT: runtimeRoot,
    INDEXTTS2_REFERENCE_AUDIO: referenceAudio,
    INDEXTTS2_SCRIPT_PATH: scriptPath,
    DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
    ...overrides,
  }
}
