import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultLocalRuntimeConfig,
  readLocalRuntimeConfig,
  resolveLocalRuntimeConfig,
  updateLocalRuntimeConfig,
  validateLocalRuntimeConfigPatch,
  writeLocalRuntimeConfig,
} from './runtime-config-store'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('runtime-config-store', () => {
  it('新安装默认使用受管 KouboRuntime WSL，旧外部端点迁移为 custom', async () => {
    const root = await tempRoot()
    expect(createDefaultLocalRuntimeConfig().duixAvatar.mode).toBe('managed_wsl')
    const legacy = createDefaultLocalRuntimeConfig()
    await fs.writeFile(path.join(root, 'runtime-config.json'), JSON.stringify({
      indextts2: legacy.indextts2,
      duixAvatar: { apiUrl: 'http://legacy-runtime:8383' },
    }))
    await expect(readLocalRuntimeConfig({ root })).resolves.toMatchObject({
      duixAvatar: { mode: 'custom', apiUrl: 'http://legacy-runtime:8383' },
    })
  })

  it('使用原子文件保存并读取 typed 配置', async () => {
    const root = await tempRoot()
    const config = createDefaultLocalRuntimeConfig()
    config.indextts2.runtimeRoot = 'C:\\IndexTTS2'

    await writeLocalRuntimeConfig(config, { root })

    await expect(readLocalRuntimeConfig({ root })).resolves.toEqual(config)
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('自动补全旧版只含 IndexTTS2 的配置', async () => {
    const root = await tempRoot()
    const legacy = createDefaultLocalRuntimeConfig()
    await fs.writeFile(path.join(root, 'runtime-config.json'), JSON.stringify({ indextts2: legacy.indextts2 }))

    await expect(readLocalRuntimeConfig({ root })).resolves.toMatchObject({
      duixAvatar: {
        apiUrl: '',
        apiDialect: 'compatible_render',
        ffprobePath: 'ffprobe',
        timeoutMs: 180000,
        pollIntervalMs: 2000,
      },
    })
  })

  it('部分更新不会丢失其他 IndexTTS2 字段', async () => {
    const root = await tempRoot()
    await updateLocalRuntimeConfig({ indextts2: { runtimeRoot: 'C:\\runtime' } }, { root })
    const updated = await updateLocalRuntimeConfig({ indextts2: { timeoutMs: 240000 } }, { root })

    expect(updated.indextts2).toMatchObject({
      runtimeRoot: 'C:\\runtime',
      timeoutMs: 240000,
      ffmpegPath: 'ffmpeg',
    })
  })

  it('保存 typed Duix 配置且不持久化 API key', async () => {
    const root = await tempRoot()
    const updated = await updateLocalRuntimeConfig({
      duixAvatar: {
        apiUrl: 'http://127.0.0.1:8383',
        apiDialect: 'duix_face2face',
        resultRoot: 'C:\\duix\\results',
        pollIntervalMs: 500,
      },
    }, { root })

    expect(updated.duixAvatar).toMatchObject({
      apiUrl: 'http://127.0.0.1:8383',
      apiDialect: 'duix_face2face',
      resultRoot: 'C:\\duix\\results',
      pollIntervalMs: 500,
    })
    expect(await fs.readFile(path.join(root, 'runtime-config.json'), 'utf8')).not.toContain('API_KEY')
  })

  it('按默认、AppData、开发 env、process.env、测试注入的顺序解析', async () => {
    const root = await tempRoot()
    const developmentRoot = await tempRoot()
    await updateLocalRuntimeConfig({ indextts2: { runtimeRoot: 'appdata', timeoutMs: 200000 } }, { root })
    await fs.writeFile(path.join(developmentRoot, '.env.runtime.local'), 'INDEXTTS2_RUNTIME_ROOT=dev\nFFMPEG_PATH=dev-ffmpeg\n')
    vi.stubEnv('INDEXTTS2_RUNTIME_ROOT', 'process')
    vi.stubEnv('FFPROBE_PATH', 'process-ffprobe')

    const resolved = await resolveLocalRuntimeConfig({
      root,
      developmentRoot,
      injectedEnv: { INDEXTTS2_RUNTIME_ROOT: 'injected' },
    })

    expect(resolved.indextts2).toMatchObject({
      runtimeRoot: 'injected',
      ffmpegPath: 'dev-ffmpeg',
      ffprobePath: 'process-ffprobe',
      timeoutMs: 200000,
    })
  })

  it('Duix env 优先于 HeyGem alias，环境覆盖 AppData', async () => {
    const root = await tempRoot()
    await updateLocalRuntimeConfig({ duixAvatar: { apiUrl: 'http://stored', timeoutMs: 200000 } }, { root })
    const resolved = await resolveLocalRuntimeConfig({
      root,
      injectedEnv: {
        DUIX_AVATAR_API_URL: 'http://duix',
        HEYGEM_API_URL: 'http://legacy',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_TIMEOUT_MS: '90000',
      },
    })
    expect(resolved.duixAvatar).toMatchObject({
      apiUrl: 'http://duix',
      apiDialect: 'duix_face2face',
      timeoutMs: 90000,
    })
  })

  it('显式 env 隔离模式不读 AppData、开发文件或 process.env', async () => {
    const root = await tempRoot()
    await updateLocalRuntimeConfig({ indextts2: { runtimeRoot: 'appdata' } }, { root })
    vi.stubEnv('INDEXTTS2_RUNTIME_ROOT', 'process')

    const resolved = await resolveLocalRuntimeConfig({
      root,
      injectedEnv: { INDEXTTS2_RUNTIME_ROOT: 'test-only' },
      isolateInjectedEnv: true,
    })

    expect(resolved.indextts2.runtimeRoot).toBe('test-only')
    expect(resolved.indextts2.ffmpegPath).toBe('ffmpeg')
    expect(resolved.duixAvatar.apiUrl).toBe('')
  })

  it('拒绝未知字段和非法超时', () => {
    expect(() => validateLocalRuntimeConfigPatch({ remoteApi: {} })).toThrow(/remoteApi/)
    expect(() => validateLocalRuntimeConfigPatch({ indextts2: { token: 'secret' } })).toThrow(/token/)
    expect(() => validateLocalRuntimeConfigPatch({ indextts2: { timeoutMs: 99 } })).toThrow(/timeoutMs/)
    expect(() => validateLocalRuntimeConfigPatch({ duixAvatar: { apiKey: 'secret' } })).toThrow(/apiKey/)
    expect(() => validateLocalRuntimeConfigPatch({ duixAvatar: { pollIntervalMs: -1 } })).toThrow(/pollIntervalMs/)
  })
})

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-runtime-config-'))
  roots.push(root)
  return root
}
