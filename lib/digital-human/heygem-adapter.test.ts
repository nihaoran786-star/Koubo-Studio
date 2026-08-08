import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildHeyGemPowerShellArgs,
  readHeyGemRuntimeConfig,
  resolveHeyGemRuntimeConfig,
  runHeyGemAdapter,
  verifyHeyGemOutput,
  windowsPathToWslMountPath,
  type HeyGemProcessRunner,
  type RunHeyGemAdapterInput,
} from './heygem-adapter'
import { updateLocalRuntimeConfig } from '@/lib/runtime-data/runtime-config-store'
import type { ManagedRuntimeReport } from '@/lib/managed-runtime/managed-runtime-types'

const tmpRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
  tmpRoots.length = 0
})

describe('HeyGem adapter', () => {
  it('maps a Windows drive path with Chinese text and spaces to fixed WSL DrvFs syntax', () => {
    expect(windowsPathToWslMountPath('D:\\口播 项目\\素材\\声音.wav')).toBe(
      '/mnt/d/口播 项目/素材/声音.wav',
    )
    expect(windowsPathToWslMountPath('C:/Users/demo/video.mp4')).toBe(
      '/mnt/c/Users/demo/video.mp4',
    )
  })

  it('每次从持久化 resolver 读取最新 Duix 配置，API key 只来自 env', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-resolver-'))
    tmpRoots.push(root)
    await updateLocalRuntimeConfig({
      duixAvatar: { apiUrl: 'http://stored-one', apiDialect: 'duix_face2face' },
    }, { root })
    const first = await resolveHeyGemRuntimeConfig({
      root,
      developmentRoot: root,
      injectedEnv: { DUIX_AVATAR_API_KEY: 'runtime-secret' },
      isolateInjectedEnv: false,
    })
    await updateLocalRuntimeConfig({ duixAvatar: { apiUrl: 'http://stored-two' } }, { root })
    const second = await resolveHeyGemRuntimeConfig({ root, developmentRoot: root })

    expect(first).toMatchObject({ apiUrl: 'http://stored-one', apiKey: 'runtime-secret', apiDialect: 'duix_face2face' })
    expect(second).toMatchObject({ apiUrl: 'http://stored-two', apiDialect: 'duix_face2face' })
    expect(second).not.toHaveProperty('apiKey', 'runtime-secret')
  })

  it('reads API and local runtime config from environment variables', () => {
    expect(
      readHeyGemRuntimeConfig({
        HEYGEM_API_URL: ' http://127.0.0.1:8383 ',
        HEYGEM_API_KEY: 'secret',
        HEYGEM_SCRIPT_PATH: 'C:\\heygem\\Invoke-HeyGem.ps1',
        HEYGEM_TIMEOUT_MS: '60000',
      }),
    ).toEqual({
      source: 'user_config',
      apiUrl: 'http://127.0.0.1:8383',
      apiKey: 'secret',
      apiDialect: 'compatible_render',
      publicAssetBaseUrl: undefined,
      resultRoot: undefined,
      hostDataRoot: undefined,
      containerDataRoot: undefined,
      scriptPath: 'C:\\heygem\\Invoke-HeyGem.ps1',
      ffprobePath: 'ffprobe',
      timeoutMs: 60000,
      pollIntervalMs: 2000,
    })
  })

  it('preserves legacy Docker-era configuration as explicit custom mode', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-managed-'))
    tmpRoots.push(root)
    await updateLocalRuntimeConfig({
      duixAvatar: { apiUrl: 'http://host.docker.internal:8383', apiDialect: 'duix_face2face' },
    }, { root })

    const config = await resolveHeyGemRuntimeConfig({
      root,
      developmentRoot: root,
      inspectManaged: async () => managedRuntimeReport('ready'),
    })

    expect(config).toMatchObject({
      source: 'user_config',
      apiUrl: 'http://host.docker.internal:8383',
      apiDialect: 'duix_face2face',
    })
  })

  it('does not fall back to a custom endpoint while managed WSL mode is unavailable', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-managed-only-'))
    tmpRoots.push(root)
    const config = await resolveHeyGemRuntimeConfig({
      root,
      developmentRoot: root,
      inspectManaged: async () => managedRuntimeReport('absent'),
    })
    expect(config).toBeUndefined()
  })

  it('keeps explicit user configuration when the managed runtime is not ready', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-managed-fallback-'))
    tmpRoots.push(root)
    await updateLocalRuntimeConfig({ duixAvatar: { apiUrl: 'http://user-runtime:8383' } }, { root })

    const config = await resolveHeyGemRuntimeConfig({
      root,
      developmentRoot: root,
      inspectManaged: async () => managedRuntimeReport('absent'),
    })

    expect(config).toMatchObject({ source: 'user_config', apiUrl: 'http://user-runtime:8383' })
  })

  it('reads the Duix face2face API dialect and result root from environment variables', () => {
    expect(
      readHeyGemRuntimeConfig({
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_API_DIALECT: 'duix_face2face',
        HEYGEM_RESULT_ROOT: 'C:\\heygem-data\\face2face',
        HEYGEM_HOST_DATA_ROOT: 'C:\\heygem-data',
        HEYGEM_CONTAINER_DATA_ROOT: '/code/data',
        HEYGEM_POLL_INTERVAL_MS: '0',
      }),
    ).toMatchObject({
      apiDialect: 'duix_face2face',
      resultRoot: 'C:\\heygem-data\\face2face',
      hostDataRoot: 'C:\\heygem-data',
      containerDataRoot: '/code/data',
      pollIntervalMs: 0,
    })
  })

  it('prefers Duix-Avatar environment aliases over legacy HeyGem names', () => {
    expect(
      readHeyGemRuntimeConfig({
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_KEY: 'duix-secret',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: 'C:\\duix-avatar\\results',
        DUIX_AVATAR_HOST_DATA_ROOT: 'C:\\duix-avatar',
        DUIX_AVATAR_CONTAINER_DATA_ROOT: '/code/data',
        DUIX_AVATAR_TIMEOUT_MS: '90000',
        DUIX_AVATAR_POLL_INTERVAL_MS: '500',
        HEYGEM_API_URL: 'http://127.0.0.1:9999',
        HEYGEM_API_KEY: 'legacy-secret',
        HEYGEM_API_DIALECT: 'compatible_render',
        HEYGEM_RESULT_ROOT: 'C:\\legacy\\results',
        HEYGEM_TIMEOUT_MS: '1',
        HEYGEM_POLL_INTERVAL_MS: '1',
      }),
    ).toMatchObject({
      apiUrl: 'http://127.0.0.1:8383',
      apiKey: 'duix-secret',
      resultRoot: 'C:\\duix-avatar\\results',
      hostDataRoot: 'C:\\duix-avatar',
      containerDataRoot: '/code/data',
      apiDialect: 'duix_face2face',
      timeoutMs: 90000,
      pollIntervalMs: 500,
    })
  })

  it('builds PowerShell arguments with artifact and avatar inputs', () => {
    const args = buildHeyGemPowerShellArgs({
      scriptPath: 'C:\\heygem\\Invoke-HeyGem.ps1',
      input: {
        projectId: 'demo',
        workspacePath: 'C:\\workspace',
        outputPath: 'C:\\workspace\\artifacts\\render\\render.mp4',
        scriptArtifact: {
          artifactId: 'script-001',
          artifactType: 'script',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: 'script-session',
          approvalStatus: 'approved',
          content: {
            title: '标题',
            hook: '开头',
            body: '正文',
            caption: '字幕',
            tags: [],
            durationSeconds: 8,
            voiceNotes: '',
            shotNotes: '',
            riskNotes: '',
          },
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
        audioArtifact: {
          artifactId: 'audio-001',
          artifactType: 'audio',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: 'voice-session',
          status: 'ready',
          source: 'indextts2',
          outputPath: 'C:\\workspace\\artifacts\\audio\\audio.wav',
          durationSeconds: 8,
          parameters: {
            text: '正文',
            speed: 1,
            emotionAlpha: 0.2,
            useRandom: false,
            outputFormat: 'wav',
          },
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
        input: {
          scriptArtifactId: 'script-001',
          audioArtifactId: 'audio-001',
          avatar: {
            source: 'library',
            id: 'a1',
            name: '林夕',
          },
          mode: 'standard',
        },
      },
    })

    expect(args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\heygem\\Invoke-HeyGem.ps1',
      '-ScriptText',
      '正文',
      '-Audio',
      'C:\\workspace\\artifacts\\audio\\audio.wav',
      '-AvatarSource',
      'library',
      '-AvatarId',
      'a1',
      '-AvatarAsset',
      '',
      '-Mode',
      'standard',
      '-Output',
      'C:\\workspace\\artifacts\\render\\render.mp4',
    ])
  })

  it('verifies generated video is inside workspace render artifacts and has duration', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-output-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'fake mp4')

    const result = await verifyHeyGemOutput({
      workspacePath: root,
      outputPath,
      probeDuration: async () => 8.2,
    })

    expect(result).toEqual({
      outputPath: path.resolve(outputPath),
      durationSeconds: 8.2,
    })
  })

  it('rejects output paths outside the workspace render artifact directory', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-output-'))
    tmpRoots.push(root)
    const outside = path.join(path.dirname(root), 'outside.mp4')

    await expect(
      verifyHeyGemOutput({
        workspacePath: root,
        outputPath: outside,
        probeDuration: async () => 1,
      }),
    ).rejects.toMatchObject({
      code: 'output_path_escape',
    })
  })

  it('runs the local PowerShell adapter and returns verified output duration', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-run-'))
    tmpRoots.push(root)
    const scriptPath = path.join(root, 'Invoke-HeyGem.ps1')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    await fs.writeFile(scriptPath, 'param()')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const runner = vi.fn<HeyGemProcessRunner>(async ({ args }) => {
      const outputIndex = args.indexOf('-Output')
      await fs.writeFile(args[outputIndex + 1], 'fake mp4')
      return { exitCode: 0, stdout: 'Generated', stderr: '', timedOut: false }
    })

    const result = await runHeyGemAdapter(
      makeAdapterInput(root, outputPath),
      {
        env: {
          HEYGEM_SCRIPT_PATH: scriptPath,
        },
        runner,
        probeDuration: async () => 7.5,
      },
    )

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 7.5,
    })
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'powershell',
        timeoutMs: 180000,
      }),
    )
  })

  it('calls the configured HeyGem API and verifies the local output video', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-api-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'runtime-results')
    const runtimeOutputPath = path.join(resultRoot, 'render-from-api.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-api.mp4')
    await fs.mkdir(resultRoot, { recursive: true })

    const fetcher = vi.fn(async () => {
      await fs.writeFile(runtimeOutputPath, 'fake mp4')
      return new Response(JSON.stringify({ status: 'ok', outputPath: runtimeOutputPath }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_API_KEY: 'secret',
        HEYGEM_RESULT_ROOT: resultRoot,
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8383/render', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
      body: expect.stringContaining('"outputPath"'),
    })
  })

  it('downloads a compatible HeyGem resultUrl into the workspace render output', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-compatible-url-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-compatible-url.mp4')
    const videoBytes = Buffer.from('compatible downloaded mp4')

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/render')) {
        return new Response(JSON.stringify({
          status: 'ok',
          resultUrl: 'https://heygem.example.com/results/render.mp4',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText === 'https://heygem.example.com/results/render.mp4') {
        return new Response(videoBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('compatible downloaded mp4')
    expect(fetcher).toHaveBeenCalledWith('https://heygem.example.com/results/render.mp4', {
      method: 'GET',
    })
  })

  it('submits and polls the Duix face2face API, then copies the result into the workspace render output', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-api-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'heygem-results')
    const resultPath = path.join(resultRoot, 'task-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(resultPath, 'fake mp4')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'previous complete mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: '10000', data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({ code: '10000', data: { status: '2', result: 'task-output.mp4' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_API_DIALECT: 'duix_face2face',
        HEYGEM_PUBLIC_ASSET_BASE_URL: 'https://public.example.com/',
        HEYGEM_RESULT_ROOT: resultRoot,
        HEYGEM_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('fake mp4')
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    const submitCall = fetcher.mock.calls.find(([url]) => String(url).endsWith('/easy/submit'))
    expect(submitCall?.[1]).toMatchObject({ method: 'POST' })
    const submitBody = JSON.parse(String((submitCall?.[1] as RequestInit).body))
    expect(submitBody).toMatchObject({
      audio_url: 'https://public.example.com/api/projects/demo/audio-artifacts/audio-001/file',
      video_url: 'https://public.example.com/api/projects/demo/avatar-assets/avatar-001/file',
    })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:8383/easy/query?code='), expect.objectContaining({
      method: 'GET',
    }))
  })

  it('keeps the previous local result and removes the temp file when atomic copy fails', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-copy-failure-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'heygem-results')
    const resultPath = path.join(resultRoot, 'task-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(resultPath, 'new mp4')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'previous complete mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/easy/query')
      ? new Response(JSON.stringify({ code: '10000', data: { status: '2', result: 'task-output.mp4' } }))
      : new Response(JSON.stringify({ code: '10000', data: { code: 'task-001' } })))
    vi.spyOn(fs, 'copyFile').mockImplementation(async (_source, destination) => {
      await fs.writeFile(destination, 'partial')
      throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_API_DIALECT: 'duix_face2face',
        HEYGEM_RESULT_ROOT: resultRoot,
        HEYGEM_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'runtime_failed' } })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('previous complete mp4')
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('verifies a local candidate before publishing and preserves the previous video on probe failure', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-candidate-probe-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'runtime-results')
    const runtimeOutputPath = path.join(resultRoot, 'broken.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(runtimeOutputPath, 'not a valid video')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, 'previous valid video')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      outputPath: runtimeOutputPath,
    })))

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_RESULT_ROOT: resultRoot,
      },
      fetcher,
      probeDuration: async () => 0,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'invalid_duration' } })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('previous valid video')
    const names = await fs.readdir(path.dirname(outputPath))
    expect(names.filter((name) => name.includes('.candidate') || name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects Duix face2face result paths outside the configured result root', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-result-escape-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'heygem-results')
    const outsideResultPath = path.join(root, 'outside-result.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(outsideResultPath, 'outside mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: '10000', data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({ code: '10000', data: { status: '2', result: '../outside-result.mp4' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_API_DIALECT: 'duix_face2face',
        HEYGEM_PUBLIC_ASSET_BASE_URL: 'https://public.example.com/',
        HEYGEM_RESULT_ROOT: resultRoot,
        HEYGEM_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'result_path_escape',
      },
    })
    await expect(fs.stat(outputPath)).rejects.toThrow()
  })

  it('downloads an HTTP Duix face2face result URL into the workspace render output', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-url-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-url.mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }
    const videoBytes = Buffer.from('downloaded mp4')

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: '10000', data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({
          code: '10000',
          data: {
            status: '2',
            result_url: 'https://duix.example.com/results/task-output.mp4',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText === 'https://duix.example.com/results/task-output.mp4') {
        return new Response(videoBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('downloaded mp4')
    expect(fetcher).toHaveBeenCalledWith('https://duix.example.com/results/task-output.mp4', {
      method: 'GET',
    })
  })

  it('maps host data paths to Duix container paths and resolves container result paths', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-container-'))
    tmpRoots.push(root)
    const hostDataRoot = path.join(root, 'heygem-data')
    const resultRoot = path.join(hostDataRoot, 'temp')
    const audioPath = path.join(resultRoot, 'audio.wav')
    const avatarPath = path.join(resultRoot, 'avatar.mp4')
    const resultPath = path.join(resultRoot, 'task-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-container.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(audioPath, 'fake wav')
    await fs.writeFile(avatarPath, 'fake mp4')
    await fs.writeFile(resultPath, 'fake mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.audioArtifact.outputPath = audioPath
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: avatarPath,
    }

    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          audio_url: '/code/data/temp/audio.wav',
          video_url: '/code/data/temp/avatar.mp4',
        })
        return new Response(JSON.stringify({ code: 10000, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({ code: 10000, data: { status: 2, result: '/task-output.mp4' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: resultRoot,
        DUIX_AVATAR_HOST_DATA_ROOT: hostDataRoot,
        DUIX_AVATAR_CONTAINER_DATA_ROOT: '/code/data',
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('fake mp4')
  })

  it('resolves the official Duix lite root-relative result into its configured temp root', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-lite-result-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'face2face', 'temp')
    const resultPath = path.join(resultRoot, 'task-output-r.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-lite.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(resultPath, 'official duix lite mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const value = String(url)
      if (value.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: 10000, data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        code: 10000,
        success: true,
        data: {
          code: 'task-001',
          status: 2,
          progress: 100,
          result: '/task-output-r.mp4',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: resultRoot,
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.524,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.524,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('official duix lite mp4')
  })

  it('waits for an official Duix result that becomes visible shortly after task completion', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-delayed-result-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'face2face', 'temp')
    const resultPath = path.join(resultRoot, 'delayed-task-r.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'delayed-render.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: 10000, data: { code: 'delayed-task' } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        code: 10000,
        data: { status: 2, progress: 100, result: '/delayed-task-r.mp4' },
      }), { status: 200 })
    }) as typeof fetch

    setTimeout(() => void fs.writeFile(resultPath, 'delayed mp4'), 100)
    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: resultRoot,
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({ status: 'ok', durationSeconds: 6.5 })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('delayed mp4')
  })

  it('accepts numeric Duix face2face status and video_url result fields', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-numeric-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-numeric.mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }
    const videoBytes = Buffer.from('numeric status mp4')

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: 10000, data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({
          code: 10000,
          data: {
            status: 2,
            video_url: 'https://duix.example.com/results/numeric-task-output.mp4',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText === 'https://duix.example.com/results/numeric-task-output.mp4') {
        return new Response(videoBytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('numeric status mp4')
  })

  it('accepts Duix face2face progress 100 with a result filename as completed', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-progress-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'heygem-results')
    const resultPath = path.join(resultRoot, 'progress-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-progress.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(resultPath, 'progress mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/easy/submit')) {
        return new Response(JSON.stringify({ code: 10000, data: { code: 'task-001' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlText.includes('/easy/query?code=')) {
        return new Response(JSON.stringify({
          code: 10000,
          data: {
            progress: 100,
            result: 'progress-output.mp4',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: resultRoot,
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'ok',
      outputPath: path.resolve(outputPath),
      durationSeconds: 6.5,
    })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('progress mp4')
  })

  it('keeps polling official Duix when progress is 100 but status is still running', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-running-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'heygem-results')
    const resultPath = path.join(resultRoot, 'running-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-running.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.writeFile(resultPath, 'completed mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }
    let queryCount = 0
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 })
      }
      queryCount += 1
      return new Response(JSON.stringify({
        code: 10000,
        data: queryCount === 1
          ? { status: 1, progress: 100, result: 'running-output.mp4' }
          : { status: 2, progress: 100, result: 'running-output.mp4' },
      }), { status: 200 })
    }) as typeof fetch

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
        DUIX_AVATAR_RESULT_ROOT: resultRoot,
        DUIX_AVATAR_POLL_INTERVAL_MS: '0',
      },
      fetcher,
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({ status: 'ok', durationSeconds: 6.5 })
    expect(queryCount).toBe(2)
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('completed mp4')
  })

  it('maps numeric Duix face2face error codes to adapter errors', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-numeric-error-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-error.mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.mp4'),
    }

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      },
      fetcher: vi.fn(async () =>
        new Response(JSON.stringify({ code: 50001, msg: 'task rejected' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'runtime_failed',
        message: 'task rejected',
      },
    })
  })

  it('rejects Duix face2face library avatars without a video asset before submitting a task', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-avatar-required-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-avatar-required.mp4')
    const fetcher = vi.fn()

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      },
      fetcher,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'duix_avatar_video_required',
      },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects Duix face2face uploaded avatars that are not video files', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-duix-avatar-extension-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render-from-duix-avatar-extension.mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', 'avatar-001.png'),
    }
    const fetcher = vi.fn()

    const result = await runHeyGemAdapter(adapterInput, {
      env: {
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
        DUIX_AVATAR_API_DIALECT: 'duix_face2face',
      },
      fetcher,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'duix_avatar_video_required',
      },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps HeyGem API failure payloads to typed adapter errors', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-api-error-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
      },
      fetcher: vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: 'adapter_error',
            error: {
              code: 'avatar_invalid',
              message: 'avatar asset rejected',
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'avatar_invalid',
        message: 'avatar asset rejected',
      },
    })
  })

  it('rejects HeyGem API output paths outside the workspace render directory', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-api-escape-'))
    tmpRoots.push(root)
    const plannedOutputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const outsideOutputPath = path.join(path.dirname(root), 'outside.mp4')
    await fs.writeFile(outsideOutputPath, 'fake mp4')

    const result = await runHeyGemAdapter(makeAdapterInput(root, plannedOutputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
      },
      fetcher: vi.fn(async () =>
        new Response(JSON.stringify({ status: 'ok', outputPath: outsideOutputPath }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
      probeDuration: async () => 6.5,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      source: 'heygem',
      error: {
        code: 'result_root_required',
      },
    })
  })

  it('rejects a remote compatible endpoint local absolute result without a trusted resultRoot', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-untrusted-local-'))
    tmpRoots.push(root)
    const outside = path.join(root, 'runtime-output.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    await fs.writeFile(outside, 'untrusted')

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher: vi.fn(async () => new Response(JSON.stringify({ status: 'ok', outputPath: outside }))),
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_root_required' } })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a result source that escapes resultRoot through a directory junction or symlink', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-link-'))
    tmpRoots.push(root)
    const resultRoot = path.join(root, 'trusted')
    const outsideRoot = path.join(root, 'outside')
    const linkedDirectory = path.join(resultRoot, 'linked')
    const outsideVideo = path.join(outsideRoot, 'video.mp4')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    await fs.mkdir(resultRoot, { recursive: true })
    await fs.mkdir(outsideRoot, { recursive: true })
    await fs.writeFile(outsideVideo, 'outside')
    await fs.symlink(outsideRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: {
        HEYGEM_API_URL: 'http://127.0.0.1:8383',
        HEYGEM_RESULT_ROOT: resultRoot,
      },
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        status: 'ok',
        outputPath: path.join(linkedDirectory, 'video.mp4'),
      }))),
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_path_escape' } })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an oversized Content-Length before consuming the result stream', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-length-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const body = new ReadableStream<Uint8Array>({})
    const oversizedResponse = new Response(body, { headers: { 'content-length': '9' } })
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/render')
      ? new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/result.mp4' }))
      : oversizedResponse)

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher,
      maxResultBytes: 8,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_too_large' } })
    expect(oversizedResponse.bodyUsed).toBe(true)
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds and cancels a large non-success result response body', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-error-body-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const errorResponse = new Response('x'.repeat(80 * 1024), { status: 502 })
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/render')
      ? new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/result.mp4' }))
      : errorResponse)

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_download_failed' } })
    expect(result.status === 'adapter_error' ? result.error.message.length : 0).toBeLessThan(66 * 1024)
    expect(result.status === 'adapter_error' ? result.error.message : '').toContain('[错误响应已截断]')
    expect(errorResponse.bodyUsed).toBe(true)
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts a chunked download once accumulated bytes exceed the limit and removes temp files', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-chunked-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'))
        controller.enqueue(new TextEncoder().encode('5678'))
        controller.close()
      },
    })
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/render')
      ? new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/result.mp4' }))
      : new Response(body))

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher,
      maxResultBytes: 6,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_too_large' } })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('cleans the temp file when the HTTP response stream is interrupted', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-interrupted-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('socket reset'))
      },
    })
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/render')
      ? new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/result.mp4' }))
      : new Response(body))

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher,
      maxResultBytes: 1024,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({ status: 'adapter_error', error: { code: 'result_download_failed' } })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('publishes a streamed result only after the temp file is synced and atomically renamed', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-result-atomic-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    let streamStarted!: () => void
    const started = new Promise<void>((resolve) => { streamStarted = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(new TextEncoder().encode('first-'))
      },
    })
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/render')) {
        return new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/result.mp4' }))
      }
      streamStarted()
      return new Response(body)
    })

    const pending = runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      env: { HEYGEM_API_URL: 'https://remote.example.com' },
      fetcher,
      maxResultBytes: 1024,
      probeDuration: async () => 2.5,
    })
    await started
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    streamController.enqueue(new TextEncoder().encode('second'))
    streamController.close()

    await expect(pending).resolves.toMatchObject({ status: 'ok', durationSeconds: 2.5 })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('first-second')
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('completes managed_wsl compatible_render through exact WSL outputPath mapping', async () => {
    const root = await createManagedWorkspace('tmp-heygem-managed-exact-')
    const outputPath = path.join(root, 'artifacts', 'render', '成片 输出.mp4')
    const adapterInput = makeAdapterInput(root, outputPath)
    adapterInput.input.avatar = {
      source: 'upload',
      id: 'avatar-001',
      name: '我的形象',
      assetPath: path.join(root, 'files', 'avatar', '形象 素材.mp4'),
    }
    let postedBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const candidate = wslMountPathToWindows(String(postedBody.outputPath))
      await fs.writeFile(candidate, 'managed video')
      return new Response(JSON.stringify({ status: 'ok', outputPath: postedBody.outputPath }))
    })

    const result = await runHeyGemAdapter(adapterInput, {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 8.25,
    })

    expect(result).toMatchObject({ status: 'ok', outputPath, durationSeconds: 8.25 })
    expect(postedBody).toMatchObject({
      pathDialect: 'wsl_mount_v1',
      audioPath: windowsPathToWslMountPath(await fs.realpath(adapterInput.audioArtifact.outputPath)),
      avatar: {
        source: 'upload',
        assetPath: windowsPathToWslMountPath(await fs.realpath(adapterInput.input.avatar.assetPath!)),
      },
    })
    expect(String(postedBody.outputPath)).toMatch(/^\/mnt\/[a-z]\//)
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('managed video')
  })

  it('rejects a managed_wsl outputPath that is not byte-for-byte identical to the requested candidate', async () => {
    const root = await createManagedWorkspace('tmp-heygem-managed-mismatch-')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ outputPath: `${String(body.outputPath)}.other` }))
    })

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'managed_output_path_mismatch' },
    })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['leading whitespace', (candidate: string) => ` ${candidate}`],
    ['trailing whitespace', (candidate: string) => `${candidate} `],
  ])('rejects managed_wsl outputPath with %s without publishing files', async (_label, alter) => {
    const root = await createManagedWorkspace('tmp-heygem-managed-whitespace-')
    const renderRoot = path.join(root, 'artifacts', 'render')
    const outputPath = path.join(renderRoot, 'render.mp4')
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const candidate = wslMountPathToWindows(String(body.outputPath))
      await fs.writeFile(candidate, 'must not be published')
      return new Response(JSON.stringify({ outputPath: alter(String(body.outputPath)) }))
    })

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'managed_output_path_mismatch' },
    })
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(renderRoot)).filter((name) => name.includes('.candidate.'))).toEqual([])
  })

  it.each([
    ['relative', 'audio.wav'],
    ['drive-relative', 'D:audio.wav'],
    ['UNC', '\\\\server\\share\\audio.wav'],
    ['device', '\\\\.\\PhysicalDrive0'],
    ['extended', '\\\\?\\D:\\audio.wav'],
    ['ADS', 'D:\\audio.wav:secret'],
    ['NUL', 'D:\\audio\u0000.wav'],
  ])('rejects managed_wsl %s input before fetch', async (_label, maliciousPath) => {
    const root = await createManagedWorkspace('tmp-heygem-managed-invalid-')
    const adapterInput = makeAdapterInput(root, path.join(root, 'artifacts', 'render', 'render.mp4'))
    adapterInput.audioArtifact.outputPath = maliciousPath
    const fetcher = vi.fn()

    const result = await runHeyGemAdapter(adapterInput, {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'managed_input_path_invalid' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects an existing managed_wsl input outside the workspace before fetch', async () => {
    const root = await createManagedWorkspace('tmp-heygem-managed-escape-')
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.wav`)
    tmpRoots.push(outside)
    await fs.writeFile(outside, 'outside')
    const adapterInput = makeAdapterInput(root, path.join(root, 'artifacts', 'render', 'render.mp4'))
    adapterInput.audioArtifact.outputPath = outside
    const fetcher = vi.fn()

    const result = await runHeyGemAdapter(adapterInput, {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'managed_input_path_escape' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires assetPath for a managed_wsl upload avatar before fetch', async () => {
    const root = await createManagedWorkspace('tmp-heygem-managed-avatar-')
    const adapterInput = makeAdapterInput(root, path.join(root, 'artifacts', 'render', 'render.mp4'))
    adapterInput.input.avatar = { source: 'upload', id: 'upload-1', name: '上传形象' }
    const fetcher = vi.fn()

    const result = await runHeyGemAdapter(adapterInput, {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 1,
    })

    expect(result).toMatchObject({
      status: 'adapter_error',
      error: { code: 'managed_avatar_path_required' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps managed_wsl resultUrl streaming support without trusting a local result path', async () => {
    const root = await createManagedWorkspace('tmp-heygem-managed-url-')
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/render')
        ? new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/managed.mp4' }))
        : new Response('managed downloaded video'))

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      resolveRuntimeConfig: async () => managedRuntimeConfig(),
      fetcher,
      probeDuration: async () => 4,
    })

    expect(result).toMatchObject({ status: 'ok', outputPath, durationSeconds: 4 })
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toBe('managed downloaded video')
  })

  it('does not alter user_config compatible_render Windows path behavior', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-user-config-paths-'))
    tmpRoots.push(root)
    const outputPath = path.join(root, 'artifacts', 'render', 'render.mp4')
    let postedBody: Record<string, unknown> = {}
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ resultUrl: 'https://cdn.example.com/user.mp4' }))
    })
    const streamingFetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/render')) return fetcher(url, init)
      return new Response('user configured downloaded video')
    })

    const result = await runHeyGemAdapter(makeAdapterInput(root, outputPath), {
      resolveRuntimeConfig: async () => ({
        ...managedRuntimeConfig(),
        source: 'user_config',
      }),
      fetcher: streamingFetcher,
      probeDuration: async () => 2,
    })

    expect(result).toMatchObject({ status: 'ok', outputPath })
    expect(postedBody.audioPath).toBe(path.join(root, 'artifacts', 'audio', 'audio.wav'))
    expect(postedBody).not.toHaveProperty('pathDialect')
  })
})

async function createManagedWorkspace(prefix: string) {
  const root = await fs.mkdtemp(path.join(process.cwd(), prefix))
  tmpRoots.push(root)
  await fs.mkdir(path.join(root, 'artifacts', 'audio'), { recursive: true })
  await fs.mkdir(path.join(root, 'files', 'avatar'), { recursive: true })
  await fs.writeFile(path.join(root, 'artifacts', 'audio', 'audio.wav'), 'audio')
  await fs.writeFile(path.join(root, 'files', 'avatar', '形象 素材.mp4'), 'avatar')
  return root
}

function managedRuntimeConfig() {
  return {
    source: 'managed_wsl' as const,
    apiUrl: 'http://127.0.0.1:8383',
    apiDialect: 'compatible_render' as const,
    ffprobePath: 'ffprobe',
    timeoutMs: 180000,
    pollIntervalMs: 2000,
  }
}

function wslMountPathToWindows(value: string) {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(value)
  if (!match) throw new Error(`unexpected WSL path: ${value}`)
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`
}

function managedRuntimeReport(status: 'ready' | 'absent'): ManagedRuntimeReport {
  const installed = status === 'ready'
  return {
    status,
    source: 'managed_runtime_probe',
    checkedAt: '2026-07-17T00:00:00.000Z',
    runtime: {
      name: 'KouboRuntime',
      installed,
      distroState: installed ? 'running' : 'absent',
      wslVersion: installed ? 2 : null,
      version: installed ? '1.0.0' : null,
      apiUrl: 'http://127.0.0.1:8383',
      health: installed ? 'healthy' : 'not_checked',
    },
    actions: {
      canImport: !installed,
      canStart: false,
      canStop: installed,
      canUninstall: installed,
    },
    error: null,
  }
}

function makeAdapterInput(workspacePath: string, outputPath: string): RunHeyGemAdapterInput {
  return {
    projectId: 'demo',
    workspacePath,
    outputPath,
    scriptArtifact: {
      artifactId: 'script-001',
      artifactType: 'script' as const,
      projectId: 'demo',
      featureType: 'digital-human' as const,
      sessionId: 'script-session',
      approvalStatus: 'approved' as const,
      content: {
        title: '标题',
        hook: '开头',
        body: '正文',
        caption: '字幕',
        tags: [],
        durationSeconds: 8,
        voiceNotes: '',
        shotNotes: '',
        riskNotes: '',
      },
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
    },
    audioArtifact: {
      artifactId: 'audio-001',
      artifactType: 'audio' as const,
      projectId: 'demo',
      featureType: 'digital-human' as const,
      sessionId: 'voice-session',
      status: 'ready' as const,
      source: 'indextts2' as const,
      outputPath: path.join(workspacePath, 'artifacts', 'audio', 'audio.wav'),
      durationSeconds: 8,
      parameters: {
        text: '正文',
        speed: 1,
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav' as const,
      },
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
    },
    input: {
      scriptArtifactId: 'script-001',
      audioArtifactId: 'audio-001',
      avatar: {
        source: 'library' as const,
        id: 'a1',
        name: '林夕',
      },
      mode: 'standard' as const,
    },
  }
}
