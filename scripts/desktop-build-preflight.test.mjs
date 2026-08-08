import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  checkDesktopBuildPreflight,
  findBundledRuntimeAssets,
  runDesktopBuildPreflight,
} from './desktop-build-preflight.mjs'

describe('desktop build preflight', () => {
  it('fails when sidecar resources are missing', () => {
    const root = path.join(os.tmpdir(), `koubo-sidecar-missing-${Date.now()}`)

    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_sidecar_missing',
      },
    })
  })

  it('passes when sidecar packaging is marked ready', () => {
    expect(checkDesktopBuildPreflight({ DESKTOP_SIDECAR_READY: '1' })).toEqual({
      status: 'ok',
      mode: 'sidecar',
    })
  })

  it('passes when Tauri backend resources are prepared', () => {
    const root = path.join(os.tmpdir(), `koubo-sidecar-ready-${Date.now()}`)
    const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
    mkdirSync(path.join(resourceDir, 'node_modules', 'playwright-core'), { recursive: true })
    writeFileSync(path.join(resourceDir, 'node.exe'), 'node')
    writeFileSync(path.join(resourceDir, 'server.js'), 'server')
    writeFileSync(path.join(resourceDir, 'node_modules', 'playwright-core', 'package.json'), '{}')

    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'ok',
      mode: 'resource_sidecar',
    })
  })

  it.each([
    [path.join('public', 'model.onnx')],
    ['KouboRuntime.tar'],
    [path.join('HeyGem-Linux-Python-Hack', 'native.so')],
    [path.join('public', 'Duix', 'native.so')],
    [path.join('.next', 'HeyGem', 'native.so')],
  ])('rejects bundled digital human runtime asset: %s', (relativePath) => {
    const root = path.join(os.tmpdir(), `koubo-runtime-asset-${Date.now()}-${Math.random()}`)
    const resourcesDir = path.join(root, 'src-tauri', 'resources')
    mkdirSync(path.dirname(path.join(resourcesDir, relativePath)), { recursive: true })
    writeFileSync(path.join(resourcesDir, relativePath), 'runtime asset')

    expect(checkDesktopBuildPreflight({ DESKTOP_SIDECAR_READY: '1' }, root)).toMatchObject({
      status: 'failed',
      error: { code: 'desktop_bundle_contains_runtime_assets' },
    })
  })

  it('allows ordinary Node backend resources and native dependencies', () => {
    const root = path.join(os.tmpdir(), `koubo-normal-backend-${Date.now()}`)
    const resourcesDir = path.join(root, 'src-tauri', 'resources')
    const backendDir = path.join(resourcesDir, 'koubo-backend')
    mkdirSync(path.join(backendDir, 'node_modules', 'playwright-core'), { recursive: true })
    mkdirSync(path.join(backendDir, 'node_modules', 'ordinary-native-addon'), { recursive: true })
    writeFileSync(path.join(backendDir, 'node.exe'), 'node')
    writeFileSync(path.join(backendDir, 'server.js'), 'server')
    writeFileSync(path.join(backendDir, 'node_modules', 'playwright-core', 'package.json'), '{}')
    writeFileSync(
      path.join(backendDir, 'node_modules', 'ordinary-native-addon', 'binding.so'),
      'ordinary native dependency',
    )

    expect(findBundledRuntimeAssets(resourcesDir)).toEqual([])
    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'ok',
      mode: 'resource_sidecar',
    })
  })

  it('rejects prepared resources that contain local settings or project data', () => {
    const root = path.join(os.tmpdir(), `koubo-sidecar-leaked-state-${Date.now()}`)
    const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
    mkdirSync(path.join(resourceDir, 'data', 'settings'), { recursive: true })
    writeFileSync(path.join(resourceDir, 'node.exe'), 'node')
    writeFileSync(path.join(resourceDir, 'server.js'), 'server')
    writeFileSync(path.join(resourceDir, 'data', 'settings', 'model-providers.json'), '{"apiKey":"secret"}')

    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'failed',
      error: { code: 'desktop_bundle_contains_forbidden_content' },
    })
  })

  it.each([
    ['.env.runtime.local', 'API_KEY=secret'],
    [path.join('app', 'page.tsx'), 'project source'],
    [path.join('tests', 'app.test.ts'), 'project test'],
    ['outside.mp4', 'user media'],
    [path.join('.next', 'server', 'route.js.map'), '{"sourcesContent":["secret"]}'],
  ])('rejects forbidden packaged content: %s', (relativePath, content) => {
    const root = path.join(os.tmpdir(), `koubo-sidecar-forbidden-${Date.now()}-${Math.random()}`)
    const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
    mkdirSync(path.join(resourceDir, 'node_modules', 'playwright-core'), { recursive: true })
    mkdirSync(path.dirname(path.join(resourceDir, relativePath)), { recursive: true })
    writeFileSync(path.join(resourceDir, 'node.exe'), 'node')
    writeFileSync(path.join(resourceDir, 'server.js'), 'server')
    writeFileSync(path.join(resourceDir, 'node_modules', 'playwright-core', 'package.json'), '{}')
    writeFileSync(path.join(resourceDir, relativePath), content)

    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'failed',
      error: { code: 'desktop_bundle_contains_forbidden_content' },
    })
  })

  it('rejects bundled browser binaries instead of shipping Chromium', () => {
    const root = path.join(os.tmpdir(), `koubo-sidecar-browser-binary-${Date.now()}`)
    const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
    mkdirSync(path.join(resourceDir, 'node_modules', 'playwright-core', '.local-browsers'), { recursive: true })
    writeFileSync(path.join(resourceDir, 'node.exe'), 'node')
    writeFileSync(path.join(resourceDir, 'server.js'), 'server')
    writeFileSync(path.join(resourceDir, 'node_modules', 'playwright-core', 'package.json'), '{}')

    expect(checkDesktopBuildPreflight({}, root)).toMatchObject({
      status: 'failed',
      error: { code: 'desktop_bundle_contains_browser_binaries' },
    })
  })

  it('allows explicit unsupported static export override', () => {
    expect(
      checkDesktopBuildPreflight({
        ALLOW_UNSUPPORTED_DESKTOP_STATIC_EXPORT: '1',
      }),
    ).toMatchObject({
      status: 'ok',
      mode: 'unsupported_static_export',
    })
  })

  it('logs actionable failure details', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const root = path.join(os.tmpdir(), `koubo-sidecar-log-missing-${Date.now()}`)

    const result = runDesktopBuildPreflight({ env: {}, root, logger })

    expect(result.status).toBe('failed')
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('desktop_sidecar_missing'),
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('pnpm smoke:desktop-backend'),
    )
  })
})
