'use client'

let tokenPromise: Promise<string> | undefined

export async function getDesktopCommandToken(fetcher: typeof fetch = fetch) {
  tokenPromise ??= fetcher('/api/desktop/command-token', { cache: 'no-store' })
    .then(async (response) => {
      const body = await response.json() as {
        status?: string
        token?: string
        error?: { code?: string; message?: string }
      }
      if (!response.ok || body.status !== 'ready' || !body.token) {
        throw new DesktopCommandClientError(
          body.error?.code || 'desktop_command_unavailable',
          body.error?.message || '桌面浏览器控制尚未就绪。',
        )
      }
      return body.token
    })
    .catch((error) => {
      tokenPromise = undefined
      throw error
    })
  return tokenPromise
}

export async function desktopCommandHeaders(fetcher: typeof fetch = fetch, json = false) {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-koubo-desktop-token': await getDesktopCommandToken(fetcher),
  }
}

export class DesktopCommandClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'DesktopCommandClientError'
  }
}
