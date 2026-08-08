import { describe, expect, it, vi } from 'vitest'
import {
  decodeManagedRuntimeOutput,
  parseManagedRuntimeManifest,
  parseWslVerboseList,
  probeManagedRuntime,
} from './managed-runtime-adapter'
import { MANAGED_RUNTIME_API_URL, MANAGED_RUNTIME_HEALTH_URL } from './managed-runtime-types'

describe('managed runtime adapter', () => {
  it('decodes UTF-16LE and parses English and Chinese WSL tables', () => {
    const english = '  NAME            STATE           VERSION\r\n* KouboRuntime    Running         2\r\n'
    const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(english, 'utf16le')])
    expect(parseWslVerboseList(decodeManagedRuntimeOutput(encoded))).toContainEqual({
      name: 'KouboRuntime', state: 'running', wslVersion: 2,
    })

    expect(parseWslVerboseList('  名称            状态            版本\r\n  KouboRuntime    已停止          2')).toContainEqual({
      name: 'KouboRuntime', state: 'stopped', wslVersion: 2,
    })
  })

  it('uses only fixed WSL commands and probes fixed loopback health after a valid manifest', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const runner = vi.fn(async (executable: string, args: readonly string[]) => {
      calls.push({ executable, args })
      if (args.includes('--list')) return command('KouboRuntime Running 2')
      return command(JSON.stringify({
        schemaVersion: 1,
        name: 'KouboRuntime',
        version: '1.0.0',
        apiUrl: MANAGED_RUNTIME_API_URL,
      }))
    })
    const healthProbe = vi.fn(async () => ({ checked: true, ok: true, statusCode: 200 }))

    const result = await probeManagedRuntime({ runner, healthProbe, systemRoot: 'C:\\Windows' })

    expect(calls).toEqual([
      { executable: 'C:\\Windows\\System32\\wsl.exe', args: ['--list', '--verbose'] },
      {
        executable: 'C:\\Windows\\System32\\wsl.exe',
        args: ['--distribution', 'KouboRuntime', '--exec', 'cat', '/etc/koubo-runtime.json'],
      },
    ])
    expect(healthProbe).toHaveBeenCalledWith(MANAGED_RUNTIME_HEALTH_URL, expect.objectContaining({
      name: 'KouboRuntime', version: '1.0.0',
    }))
    expect(result.manifest?.version).toBe('1.0.0')
  })

  it('rejects manifests that redirect the API away from the fixed loopback endpoint', () => {
    expect(parseManagedRuntimeManifest(command(JSON.stringify({
      schemaVersion: 1,
      name: 'KouboRuntime',
      version: '1.0.0',
      apiUrl: 'http://example.com:8383',
    })))).toBeNull()
  })

  it('does not accept a different service identity on the managed loopback port', async () => {
    const runner = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args.includes('--list')) return command('KouboRuntime Running 2')
      return command(JSON.stringify({
        schemaVersion: 1, name: 'KouboRuntime', version: '2.0.0', apiUrl: MANAGED_RUNTIME_API_URL,
      }))
    })
    const healthProbe = vi.fn(async (_url: string, manifest: { version: string }) => ({
      checked: true, ok: manifest.version === 'old-docker', statusCode: 200,
    }))

    const result = await probeManagedRuntime({ runner, healthProbe })

    expect(result.health).toEqual({ checked: true, ok: false, statusCode: 200 })
  })
})

function command(stdout = '', ok = true) {
  return { ok, exitCode: ok ? 0 : 1, stdout, stderr: '' }
}
