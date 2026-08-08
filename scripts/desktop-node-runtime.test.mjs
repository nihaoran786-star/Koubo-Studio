import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDesktopNodeRuntime } from './desktop-node-runtime.mjs'

function makeNode(root, name) {
  const nodePath = path.join(root, name)
  mkdirSync(path.dirname(nodePath), { recursive: true })
  writeFileSync(nodePath, name)
  return nodePath
}

describe('desktop node runtime resolver', () => {
  it('uses the explicit supported runtime before every fallback', () => {
    const root = path.join(os.tmpdir(), `koubo-node-explicit-${Date.now()}`)
    const explicit = makeNode(root, 'explicit.exe')
    const current = makeNode(root, 'current.exe')

    expect(resolveDesktopNodeRuntime({
      root,
      env: { DESKTOP_BACKEND_NODE_PATH: explicit },
      processExecPath: current,
      codexCandidates: [],
      getNodeVersion: (candidate) => ({ status: 'ok', version: candidate === explicit ? '24.14.0' : '23.0.0' }),
    })).toMatchObject({ status: 'ok', nodePath: explicit, nodeVersion: '24.14.0', source: 'explicit' })
  })

  it('skips an unsupported current process and selects the packaged project runtime', () => {
    const root = path.join(os.tmpdir(), `koubo-node-bundled-${Date.now()}`)
    const current = makeNode(root, 'node20.exe')
    const bundled = makeNode(path.join(root, 'src-tauri', 'resources', 'koubo-backend'), 'node.exe')

    expect(resolveDesktopNodeRuntime({
      root,
      env: {},
      processExecPath: current,
      codexCandidates: [],
      getNodeVersion: (candidate) => ({ status: 'ok', version: candidate === bundled ? '24.14.0' : '20.20.0' }),
    })).toMatchObject({ status: 'ok', nodePath: bundled, source: 'project_bundle' })
  })

  it('returns a stable diagnostic when no candidate satisfies the minimum version', () => {
    const root = path.join(os.tmpdir(), `koubo-node-missing-${Date.now()}`)
    const current = makeNode(root, 'node20.exe')

    const result = resolveDesktopNodeRuntime({
      root,
      env: {},
      processExecPath: current,
      codexCandidates: [],
      getNodeVersion: () => ({ status: 'ok', version: '20.20.0' }),
    })
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'desktop_node_runtime_unavailable' },
    })
    expect(result.attempts[0]).toMatchObject({ nodePath: current, source: 'process', status: 'unsupported' })
  })
})
