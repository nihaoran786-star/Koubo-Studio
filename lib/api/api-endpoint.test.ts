import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApiEndpoint,
  buildProjectApiEndpoint,
  readApiBaseUrl,
} from './api-endpoint'

describe('api endpoint builder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps relative endpoints by default', () => {
    expect(buildApiEndpoint('/api/projects/demo/script-agent', {})).toBe('/api/projects/demo/script-agent')
  })

  it('prefixes endpoints with configured desktop local backend URL', () => {
    expect(
      buildApiEndpoint('/api/projects/demo/script-agent', {
        NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100/ ',
      }),
    ).toBe('http://127.0.0.1:3100/api/projects/demo/script-agent')
  })

  it('builds encoded project API endpoints with query strings', () => {
    expect(
      buildProjectApiEndpoint('demo project', '/script-agent?mode=clarify', {
        NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL: 'http://127.0.0.1:3100',
      }),
    ).toBe('http://127.0.0.1:3100/api/projects/demo%20project/script-agent?mode=clarify')
  })

  it('normalizes API base URL from public environment', () => {
    expect(
      readApiBaseUrl({
        NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100/ ',
      }),
    ).toBe('http://127.0.0.1:3100')
  })

  it('can read a browser runtime API base URL override', () => {
    vi.stubGlobal('window', {
      __KOUBO_API_BASE_URL__: ' http://127.0.0.1:3100/ ',
    })

    expect(buildApiEndpoint('/api/projects/demo/script-agent')).toBe(
      'http://127.0.0.1:3100/api/projects/demo/script-agent',
    )
  })
})
