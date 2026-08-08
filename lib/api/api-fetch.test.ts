import { describe, expect, it, vi } from 'vitest'
import { requestJson } from './api-fetch'

describe('api fetch', () => {
  it('returns parsed JSON for successful API responses', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      requestJson('/api/demo', {
        fetcher,
        fallback: () => ({ status: 'error' }),
      }),
    ).resolves.toEqual({ status: 'ok' })
  })

  it('returns stable desktop backend error fallback when fetch fails', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(
      requestJson('/api/demo', {
        fetcher,
        fallback: (error) => ({
          status: 'adapter_error',
          source: 'desktop_runtime',
          error,
        }),
      }),
    ).resolves.toMatchObject({
      status: 'adapter_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('returns stable desktop backend error fallback when response is not JSON', async () => {
    const fetcher = vi.fn(async () =>
      new Response('<html>static shell</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )

    await expect(
      requestJson('/api/demo', {
        fetcher,
        fallback: (error) => ({
          status: 'adapter_error',
          source: 'desktop_runtime',
          error,
        }),
      }),
    ).resolves.toMatchObject({
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})

