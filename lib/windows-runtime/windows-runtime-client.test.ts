import { describe, expect, it, vi } from 'vitest'
import { createWindowsRuntimeClient } from './windows-runtime-client'

const validResult = {
  status: 'ok',
  source: 'windows_runtime',
  assessment: {
    grade: 'smooth',
    label: '硬件已通过',
    summary: '硬件满足流畅运行本地数字人的建议配置。',
  },
  checks: [{
    id: 'wsl',
    title: 'WSL 2',
    status: 'ready',
    detail: 'WSL 2 已就绪。',
  }],
  install: {
    wslInstalled: true,
    restartRequired: false,
    kouboRuntimeInstalled: false,
    canInstallWsl: false,
  },
}

describe('windows runtime client', () => {
  it('accepts the complete structured assessment', async () => {
    const fetcher = vi.fn(async () => jsonResponse(validResult)) as typeof fetch

    await expect(createWindowsRuntimeClient(fetcher).get()).resolves.toEqual(validResult)
  })

  it.each([
    { ...validResult, assessment: { ...validResult.assessment, grade: 'fast' } },
    { ...validResult, checks: [{ ...validResult.checks[0], status: 'maybe' }] },
    { ...validResult, checks: [{ ...validResult.checks[0], detail: '' }] },
    { ...validResult, install: {} },
    { ...validResult, install: { ...validResult.install, canInstallWsl: 'yes' } },
  ])('rejects malformed success payloads instead of guessing UI state', async (payload) => {
    const fetcher = vi.fn(async () => jsonResponse(payload)) as typeof fetch

    await expect(createWindowsRuntimeClient(fetcher).get()).resolves.toMatchObject({
      status: 'error',
      source: 'windows_runtime',
      error: { code: 'invalid_response' },
    })
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
