import { describe, expect, it } from 'vitest'
import { inspectManagedRuntime } from './managed-runtime-service'
import {
  MANAGED_RUNTIME_API_URL,
  type ManagedRuntimeDistro,
  type ManagedRuntimeProbe,
} from './managed-runtime-types'

describe('inspectManagedRuntime', () => {
  it('reports absent without reading persisted configuration', async () => {
    const result = await inspectManagedRuntime({ probe: async () => probe({ distro: null }) })
    expect(result).toMatchObject({
      status: 'absent',
      source: 'managed_runtime_probe',
      runtime: { installed: false, distroState: 'absent', wslVersion: null },
      actions: { canImport: true, canStart: false },
      error: null,
    })
  })

  it('rejects a KouboRuntime WSL 1 distro', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({ distro: distro('stopped', 1) }),
    })
    expect(result).toMatchObject({
      status: 'failed',
      runtime: { installed: true, wslVersion: 1 },
      error: { code: 'unsupported_wsl_version' },
    })
  })

  it('reports a stopped WSL 2 distro as startable', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({ distro: distro('stopped', 2) }),
    })
    expect(result).toMatchObject({
      status: 'stopped',
      runtime: { installed: true, distroState: 'stopped', health: 'not_checked' },
      actions: { canStart: true, canStop: false, canUninstall: true },
      error: null,
    })
  })

  it('reports ready only when the running distro has a valid manifest and healthy API', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({
        distro: distro('running', 2),
        manifestCommand: command('{}'),
        manifest: {
          schemaVersion: 1,
          name: 'KouboRuntime',
          version: '2026.7.1',
          apiUrl: MANAGED_RUNTIME_API_URL,
        },
        health: { checked: true, ok: true, statusCode: 200 },
      }),
    })
    expect(result).toMatchObject({
      status: 'ready',
      runtime: { distroState: 'running', version: '2026.7.1', health: 'healthy' },
      actions: { canStop: true },
      error: null,
    })
  })

  it('classifies a damaged manifest as failed and never ready', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({
        distro: distro('running', 2),
        manifestCommand: command('{broken'),
        manifest: null,
      }),
    })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'manifest_invalid' } })
  })

  it('keeps a running but unhealthy service distinct from ready', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({
        distro: distro('running', 2),
        manifestCommand: command('{}'),
        manifest: {
          schemaVersion: 1,
          name: 'KouboRuntime',
          version: '1.0.0',
          apiUrl: MANAGED_RUNTIME_API_URL,
        },
        health: { checked: true, ok: false, statusCode: 503 },
      }),
    })
    expect(result).toMatchObject({
      status: 'running', runtime: { health: 'unhealthy' }, error: { code: 'health_unavailable' },
    })
  })

  it('returns a stable failed result when the WSL list command fails', async () => {
    const result = await inspectManagedRuntime({
      probe: async () => probe({ list: command('', false), distro: null }),
    })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'probe_failed' } })
  })
})

function probe(overrides: Partial<ManagedRuntimeProbe> = {}): ManagedRuntimeProbe {
  return {
    list: command('KouboRuntime Stopped 2'),
    distro: distro('stopped', 2),
    manifestCommand: null,
    manifest: null,
    health: { checked: false, ok: false, statusCode: null },
    ...overrides,
  }
}

function distro(state: ManagedRuntimeDistro['state'], wslVersion: number): ManagedRuntimeDistro {
  return { name: 'KouboRuntime', state, wslVersion }
}

function command(stdout = '', ok = true) {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: ok ? '' : 'failed' }
}

