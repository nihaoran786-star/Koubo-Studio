import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopDevBackendPlan, runDesktopDevBackend } from './desktop-dev-backend.mjs'

describe('desktop dev backend', () => {
  it('loads runtime env and builds a Next dev launch using the resolved Node', () => {
    const root = path.join(os.tmpdir(), `koubo-desktop-dev-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '.env.runtime.local'), 'PI_API_KEY=local-key\n')
    const nodePath = path.join(root, 'node24.exe')

    expect(createDesktopDevBackendPlan({
      root,
      env: {},
      resolveNode: () => ({ status: 'ok', nodePath, nodeVersion: '24.14.0', source: 'project_bundle' }),
    })).toMatchObject({
      status: 'ok',
      command: nodePath,
      args: [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', '3100'],
      env: { PI_API_KEY: 'local-key' },
    })
  })

  it('forwards parent signals to Next and preserves the child exit code', async () => {
    const child = new EventEmitter()
    child.kill = vi.fn()
    const spawn = vi.fn(() => child)
    const processRef = new EventEmitter()
    processRef.exitCode = undefined
    processRef.pid = 123
    processRef.kill = vi.fn()

    const pending = runDesktopDevBackend({
      root: 'D:\\project',
      processRef,
      spawn,
      createPlan: () => ({ status: 'ok', command: 'node24.exe', args: ['next', 'dev'], env: {} }),
    })
    processRef.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', 7, null)
    await expect(pending).resolves.toMatchObject({ status: 'failed', exitCode: 7 })
    expect(processRef.exitCode).toBe(7)
  })

  it('is the Tauri development entrypoint and keeps Cargo output inside the project', () => {
    const root = process.cwd()
    const tauri = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    const cargo = readFileSync(path.join(root, 'src-tauri', '.cargo', 'config.toml'), 'utf8')
    expect(tauri.build.beforeDevCommand).toBe('node scripts/desktop-dev-backend.mjs')
    expect(cargo).toContain('target-dir = ".target"')
  })
})
