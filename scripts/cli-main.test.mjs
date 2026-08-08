import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isMainModule } from './cli-main.mjs'

describe('cli main helper', () => {
  it('detects the main module with spaces and non-ASCII paths', () => {
    const scriptPath = path.join(os.tmpdir(), '口播 evidence report.mjs')

    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true)
    expect(isMainModule(pathToFileURL(scriptPath).href, path.join(os.tmpdir(), 'other.mjs'))).toBe(false)
  })

  it('returns false when argv path is missing', () => {
    const scriptPath = path.join(os.tmpdir(), 'script.mjs')

    expect(isMainModule(pathToFileURL(scriptPath).href, undefined)).toBe(false)
  })
})
