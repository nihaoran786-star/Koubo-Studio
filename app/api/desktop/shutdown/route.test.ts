import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'

const token = 'c'.repeat(32)

function request(tokenValue: string) {
  return new Request('http://127.0.0.1:3100/api/desktop/shutdown', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3100',
      origin: 'http://127.0.0.1:3100',
      'sec-fetch-site': 'same-origin',
      'x-koubo-desktop-token': tokenValue,
    },
  })
}

describe('desktop shutdown route', () => {
  beforeEach(() => {
    vi.stubEnv('KOUBO_DESKTOP_API_TOKEN', token)
    vi.stubEnv('KOUBO_BACKEND_PORT', '3100')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('closes the browser runtime before the sidecar exits', async () => {
    const response = await POST(request(token))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'closed' })
  })

  it('rejects an unauthenticated shutdown command', async () => {
    const response = await POST(request('wrong'))
    expect(response.status).toBe(403)
  })
})
