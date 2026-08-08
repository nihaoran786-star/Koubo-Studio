import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareDesktopBackendBundle, runPrepareDesktopBackendBundle } from './prepare-desktop-backend-bundle.mjs'

describe('prepare desktop backend bundle', () => {
  it('fails when standalone server is missing', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-missing-${Date.now()}`)

    expect(prepareDesktopBackendBundle({ root })).toMatchObject({
      status: 'failed',
      error: {
        code: 'standalone_server_missing',
      },
    })
  })

  it('copies standalone backend and node runtime into Tauri resources', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-ready-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const staticDir = path.join(root, '.next', 'static')
    const publicDir = path.join(root, 'public')
    const fakeNode = path.join(root, 'node.exe')
    const staleReleaseResource = path.join(
      root,
      'src-tauri',
      '.target',
      'release',
      'resources',
      'koubo-backend',
      'node_modules',
      '.pnpm',
      'stale-package',
    )
    mkdirSync(standalone, { recursive: true })
    mkdirSync(staticDir, { recursive: true })
    mkdirSync(publicDir, { recursive: true })
    mkdirSync(staleReleaseResource, { recursive: true })
    mkdirSync(path.join(standalone, 'data', 'settings'), { recursive: true })
    mkdirSync(path.join(standalone, 'app'), { recursive: true })
    mkdirSync(path.join(standalone, 'components'), { recursive: true })
    mkdirSync(path.join(standalone, 'lib'), { recursive: true })
    mkdirSync(path.join(standalone, 'scripts'), { recursive: true })
    mkdirSync(path.join(standalone, 'tests'), { recursive: true })
    mkdirSync(path.join(standalone, 'docs'), { recursive: true })
    mkdirSync(path.join(standalone, 'out'), { recursive: true })
    mkdirSync(path.join(standalone, '.pi-app', 'sessions'), { recursive: true })
    mkdirSync(path.join(standalone, '.pi-app', 'features', 'digital-human'), { recursive: true })
    mkdirSync(
      path.join(standalone, 'node_modules', '.pnpm', '@swc+helpers@0.5.15', 'node_modules', '@swc', 'helpers'),
      { recursive: true },
    )
    mkdirSync(
      path.join(standalone, 'node_modules', '.pnpm', '@next+env@16.2.6', 'node_modules', '@next', 'env'),
      { recursive: true },
    )
    mkdirSync(path.join(standalone, 'node_modules', '.pnpm', '@img+sharp-win32-x64@1', 'node_modules', '@img', 'sharp-win32-x64'), { recursive: true })
    mkdirSync(path.join(standalone, 'node_modules', '.pnpm', '@img+sharp-linux-x64@1', 'node_modules', '@img', 'sharp-linux-x64'), { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(path.join(standalone, 'package.json'), '{"name":"runtime"}')
    writeFileSync(path.join(standalone, '.env.runtime.local'), 'API_KEY=must-not-ship')
    writeFileSync(path.join(standalone, 'outside.mp4'), 'user-media')
    writeFileSync(path.join(standalone, 'README.md'), 'project docs')
    writeFileSync(path.join(standalone, 'app', 'page.tsx'), 'project source')
    writeFileSync(path.join(standalone, 'components', 'card.tsx'), 'project source')
    writeFileSync(path.join(standalone, 'lib', 'secret.ts'), 'project source')
    writeFileSync(path.join(standalone, 'scripts', 'debug.mjs'), 'project script')
    writeFileSync(path.join(standalone, 'tests', 'debug.test.ts'), 'project test')
    writeFileSync(path.join(standalone, 'docs', 'CONTEXT.md'), 'project docs')
    writeFileSync(path.join(standalone, 'out', 'user-export.mp4'), 'user-media')
    writeFileSync(path.join(standalone, 'data', 'settings', 'model-providers.json'), '{"apiKey":"must-not-ship"}')
    writeFileSync(path.join(standalone, '.pi-app', 'sessions', 'session.json'), '{}')
    writeFileSync(path.join(standalone, '.pi-app', 'features', 'digital-human', 'SYSTEM.md'), 'safe prompt')
    writeFileSync(
      path.join(standalone, 'node_modules', '.pnpm', '@swc+helpers@0.5.15', 'node_modules', '@swc', 'helpers', 'index.js'),
      'module.exports = {}',
    )
    writeFileSync(
      path.join(standalone, 'node_modules', '.pnpm', '@next+env@16.2.6', 'node_modules', '@next', 'env', 'index.js'),
      'module.exports = {}',
    )
    writeFileSync(path.join(standalone, 'node_modules', '.pnpm', '@img+sharp-win32-x64@1', 'node_modules', '@img', 'sharp-win32-x64', 'index.js'), 'windows')
    writeFileSync(path.join(standalone, 'node_modules', '.pnpm', '@img+sharp-linux-x64@1', 'node_modules', '@img', 'sharp-linux-x64', 'index.js'), 'linux')
    writeFileSync(path.join(standalone, 'node_modules', '.pnpm', '@next+env@16.2.6', 'node_modules', '@next', 'env', 'index.js.map'), '{}')
    mkdirSync(path.join(standalone, 'src-tauri', 'resources', 'koubo-backend'), { recursive: true })
    writeFileSync(path.join(standalone, 'src-tauri', 'resources', 'koubo-backend', 'recursive.txt'), 'bad')
    writeFileSync(path.join(staticDir, 'asset.txt'), 'static')
    writeFileSync(path.join(staticDir, 'server.js.map'), '{"sourcesContent":["secret source"]}')
    writeFileSync(path.join(publicDir, 'image.txt'), 'public')
    writeFileSync(fakeNode, 'node')
    writeFileSync(path.join(staleReleaseResource, 'index.js'), 'must be removed')

    const result = prepareDesktopBackendBundle({
      root,
      nodePath: fakeNode,
      getNodeVersion: () => ({
        status: 'ok',
        version: '22.19.0',
      }),
    })

    expect(result).toMatchObject({
      status: 'ok',
      resourceDir: path.join(root, 'src-tauri', 'resources', 'koubo-backend'),
    })
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'server.js'))).toBe(true)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node.exe'))).toBe(true)
    expect(
      existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '@swc', 'helpers', 'index.js')),
    ).toBe(true)
    expect(
      existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '@next', 'env', 'index.js')),
    ).toBe(true)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '.pnpm'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '@img', 'sharp-win32-x64', 'index.js'))).toBe(true)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '@img', 'sharp-linux-x64'))).toBe(process.platform !== 'win32')
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules', '@next', 'env', 'index.js.map'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', '.next', 'static', 'asset.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'public', 'image.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'src-tauri'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'data'))).toBe(false)
    for (const forbidden of [
      '.env.runtime.local', 'outside.mp4', 'README.md', 'app', 'components', 'lib',
      'scripts', 'tests', 'docs', 'out',
    ]) {
      expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', forbidden))).toBe(false)
    }
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', '.next', 'static', 'server.js.map'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', '.pi-app', 'sessions'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', '.pi-app'))).toBe(false)
    expect(existsSync(path.join(root, 'src-tauri', '.target', 'release', 'resources', 'koubo-backend'))).toBe(false)
  })

  it('materializes a standalone package junction without copying adjacent workspace files', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-junction-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const standaloneNodeModules = path.join(standalone, 'node_modules')
    const packageTarget = path.join(root, 'node_modules', '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture')
    const packageJunction = path.join(standaloneNodeModules, 'fixture')
    const fakeNode = path.join(root, 'node.exe')
    mkdirSync(standaloneNodeModules, { recursive: true })
    mkdirSync(packageTarget, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(path.join(packageTarget, 'index.js'), 'module.exports = "fixture"')
    writeFileSync(path.join(packageTarget, '..', 'workspace-secret.txt'), 'must-not-ship')
    writeFileSync(fakeNode, 'node')
    symlinkSync(packageTarget, packageJunction, 'junction')

    const result = prepareDesktopBackendBundle({
      root,
      nodePath: fakeNode,
      getNodeVersion: () => ({
        status: 'ok',
        version: '24.14.0',
      }),
    })

    const bundledNodeModules = path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'node_modules')
    const bundledPackage = path.join(bundledNodeModules, 'fixture')
    expect(result.status).toBe('ok')
    expect(readFileSync(path.join(bundledPackage, 'index.js'), 'utf8')).toBe('module.exports = "fixture"')
    expect(lstatSync(bundledPackage).isSymbolicLink()).toBe(false)
    expect(existsSync(path.join(bundledNodeModules, 'workspace-secret.txt'))).toBe(false)
    expect(existsSync(path.join(bundledNodeModules, '.pnpm'))).toBe(false)
  })

  it('rejects a standalone junction that escapes the allowed source roots', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-junction-escape-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const outside = path.join(os.tmpdir(), `koubo-bundle-outside-${Date.now()}`)
    const fakeNode = path.join(root, 'node.exe')
    mkdirSync(path.join(standalone, 'node_modules'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(path.join(outside, 'secret.txt'), 'must-not-ship')
    writeFileSync(fakeNode, 'node')
    symlinkSync(outside, path.join(standalone, 'node_modules', 'escaped'), 'junction')

    let thrown
    try {
      prepareDesktopBackendBundle({
        root,
        nodePath: fakeNode,
        getNodeVersion: () => ({
          status: 'ok',
          version: '24.14.0',
        }),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      code: 'desktop_bundle_source_escape',
    })
  })

  it('rejects a junction cycle without recursively copying it', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-junction-cycle-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const packageTarget = path.join(root, 'node_modules', 'fixture')
    const fakeNode = path.join(root, 'node.exe')
    mkdirSync(path.join(standalone, 'node_modules'), { recursive: true })
    mkdirSync(packageTarget, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(path.join(packageTarget, 'index.js'), 'module.exports = "fixture"')
    writeFileSync(fakeNode, 'node')
    symlinkSync(packageTarget, path.join(standalone, 'node_modules', 'fixture'), 'junction')
    symlinkSync(packageTarget, path.join(packageTarget, 'self'), 'junction')

    let thrown
    try {
      prepareDesktopBackendBundle({
        root,
        nodePath: fakeNode,
        getNodeVersion: () => ({
          status: 'ok',
          version: '24.14.0',
        }),
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({
      code: 'desktop_bundle_source_cycle',
    })
  })

  it('fails before copying when node runtime does not satisfy backend requirements', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-node20-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const fakeNode = path.join(root, 'node.exe')
    mkdirSync(standalone, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(fakeNode, 'node')

    const result = prepareDesktopBackendBundle({
      root,
      nodePath: fakeNode,
      getNodeVersion: () => ({
        status: 'ok',
        version: '20.20.0',
      }),
    })

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'node_runtime_unsupported',
      },
      nodeVersion: '20.20.0',
    })
    expect(existsSync(path.join(root, 'src-tauri', 'resources', 'koubo-backend', 'server.js'))).toBe(false)
  })

  it('preserves node runtime when the source is inside the rebuilt resource directory', () => {
    const root = path.join(os.tmpdir(), `koubo-bundle-self-node-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
    const bundledNode = path.join(resourceDir, 'node.exe')
    mkdirSync(standalone, { recursive: true })
    mkdirSync(resourceDir, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("server")')
    writeFileSync(bundledNode, 'node-v24')

    const result = prepareDesktopBackendBundle({
      root,
      nodePath: bundledNode,
      getNodeVersion: () => ({
        status: 'ok',
        version: '24.14.0',
      }),
    })

    expect(result).toMatchObject({
      status: 'ok',
      nodePath: bundledNode,
    })
    expect(existsSync(path.join(resourceDir, 'server.js'))).toBe(true)
    expect(existsSync(bundledNode)).toBe(true)
  })

  it('uses the shared resolver in the CLI path instead of the current process runtime', () => {
    const node24 = 'C:\\runtime\\node24.exe'
    const prepare = vi.fn(() => ({ status: 'ok', resourceDir: 'bundle' }))

    const result = runPrepareDesktopBackendBundle({
      root: 'D:\\project',
      env: {},
      resolveNode: () => ({ status: 'ok', nodePath: node24, nodeVersion: '24.14.0' }),
      prepare,
      logger: { log: vi.fn(), error: vi.fn() },
    })

    expect(result.status).toBe('ok')
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ root: 'D:\\project', nodePath: node24 }))
  })
})
