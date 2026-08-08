import { describe, expect, it } from 'vitest'
import { decodeWindowsOutput, probeWindowsRuntime } from './windows-runtime-adapter'

describe('decodeWindowsOutput', () => {
  it('decodes UTF-16LE output emitted by wsl.exe', () => {
    const output = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Ubuntu\r\nKouboRuntime\r\n', 'utf16le'),
    ])

    expect(decodeWindowsOutput(output)).toBe('Ubuntu\r\nKouboRuntime\r\n')
  })

  it('keeps ordinary UTF-8 command output intact', () => {
    expect(decodeWindowsOutput(Buffer.from('NVIDIA GeForce RTX 4090, 16384, 572.83')))
      .toBe('NVIDIA GeForce RTX 4090, 16384, 572.83')
  })

  it('runs only fixed executables from the Windows system directory', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    await probeWindowsRuntime({
      platform: 'win32',
      systemRoot: 'X:\\Windows',
      runtimePath: 'X:\\KouboRuntime',
      runner: async (executable, args) => {
        calls.push({ executable, args })
        return { ok: false, exitCode: 1, stdout: '', stderr: 'not installed' }
      },
    })

    expect(calls.map((call) => call.executable)).toEqual([
      'X:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'X:\\Windows\\System32\\wsl.exe',
      'X:\\Windows\\System32\\wsl.exe',
      'X:\\Windows\\System32\\wsl.exe',
      'X:\\Windows\\System32\\nvidia-smi.exe',
    ])
    expect(calls[1]?.args).toEqual(['--status'])
    expect(calls[2]?.args).toEqual(['--version'])
    expect(calls[3]?.args).toEqual(['--list', '--quiet'])
  })
})
