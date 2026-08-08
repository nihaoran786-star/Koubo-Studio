import { describe, expect, it } from 'vitest'
import {
  authorizeDesktopCommand,
  DesktopCommandAuthError,
  issueDesktopCommandToken,
} from './desktop-command-auth'

const env = { KOUBO_DESKTOP_API_TOKEN: 'a'.repeat(32), KOUBO_BACKEND_PORT: '3100' }

function request(headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1:3100/api/desktop/command-token', {
    headers: { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100', 'sec-fetch-site': 'same-origin', ...headers },
  })
}

describe('desktop command auth', () => {
  it('issues the in-memory token only to the same-origin desktop page', () => {
    expect(issueDesktopCommandToken(request(), env)).toBe('a'.repeat(32))
    expect(issueDesktopCommandToken(request({ origin: '', referer: 'http://127.0.0.1:3100/' }), env)).toBe('a'.repeat(32))
  })

  it('authorizes a matching custom header', () => {
    expect(() => authorizeDesktopCommand(request({ 'x-koubo-desktop-token': 'a'.repeat(32) }), env)).not.toThrow()
  })

  it.each([
    ['foreign origin', { origin: 'https://example.com' }, 'untrusted_origin'],
    ['foreign host', { host: 'example.com' }, 'untrusted_host'],
    ['missing token', {}, 'invalid_desktop_token'],
  ])('rejects %s', (_label, headers, code) => {
    try {
      authorizeDesktopCommand(request(headers), env)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopCommandAuthError)
      expect((error as DesktopCommandAuthError).code).toBe(code)
    }
  })
})
