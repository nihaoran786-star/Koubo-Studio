import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkDesktopBackendArtifact } from './desktop-backend-artifact-preflight.mjs'

describe('desktop backend artifact preflight', () => {
  it('fails when standalone server artifact is missing', () => {
    const root = path.join(os.tmpdir(), `koubo-missing-${Date.now()}`)

    expect(checkDesktopBackendArtifact({ root })).toMatchObject({
      status: 'failed',
      error: {
        code: 'sidecar_artifact_missing',
      },
    })
  })

  it('passes when standalone server artifact exists', () => {
    const root = path.join(os.tmpdir(), `koubo-ready-${Date.now()}`)
    const standalone = path.join(root, '.next', 'standalone')
    mkdirSync(standalone, { recursive: true })
    writeFileSync(path.join(standalone, 'server.js'), 'console.log("ready")')

    expect(checkDesktopBackendArtifact({ root })).toMatchObject({
      status: 'ok',
      mode: 'next_standalone',
      serverPath: path.join(root, '.next', 'standalone', 'server.js'),
    })
  })
})

