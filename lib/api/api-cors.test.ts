import { describe, expect, it } from 'vitest'
import { corsHeadersForRequest, corsOriginForRequest, isTrustedApiWriteOrigin, rejectUntrustedApiWrite } from './api-cors'

describe('api cors', () => {
  it('allows local development origins', () => {
    expect(corsOriginForRequest('http://127.0.0.1:3112')).toBe('http://127.0.0.1:3112')
    expect(corsOriginForRequest('http://localhost:3102')).toBe('http://localhost:3102')
  })

  it('allows tauri local origin', () => {
    expect(corsOriginForRequest('http://tauri.localhost')).toBe('http://tauri.localhost')
  })

  it('rejects non-local web origins', () => {
    expect(corsOriginForRequest('https://example.com')).toBe('')
  })

  it('builds preflight headers for allowed origins', () => {
    expect(corsHeadersForRequest('http://127.0.0.1:3112')).toMatchObject({
      'Access-Control-Allow-Origin': 'http://127.0.0.1:3112',
      'Access-Control-Allow-Methods': expect.stringContaining('OPTIONS'),
      Vary: 'Origin',
    })
  })

  it('rejects explicit cross-site origins for loopback writes', () => {
    expect(isTrustedApiWriteOrigin('https://malicious.example')).toBe(false)
    expect(isTrustedApiWriteOrigin('null')).toBe(false)
    expect(isTrustedApiWriteOrigin('http://127.0.0.1:3100')).toBe(true)
    expect(isTrustedApiWriteOrigin(null)).toBe(true)
  })

  it('returns the same typed rejection for upload routes that bypass proxy buffering', async () => {
    const response = rejectUntrustedApiWrite(new Request('http://localhost/api/projects/demo/audio-assets', {
      method: 'POST',
      headers: { origin: 'https://malicious.example' },
    }))

    expect(response?.status).toBe(403)
    await expect(response?.json()).resolves.toMatchObject({
      status: 'forbidden',
      source: 'loopback_api',
      error: { code: 'untrusted_origin' },
    })
    expect(rejectUntrustedApiWrite(new Request('http://localhost/api/projects/demo/audio-assets', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3100' },
    }))).toBeUndefined()
  })
})
