import { describe, expect, it } from 'vitest'
import { isTauriInstallResponse } from './windows-runtime-install-client'

describe('isTauriInstallResponse', () => {
  it('accepts the fixed desktop success and error contracts', () => {
    expect(isTauriInstallResponse({
      status: 'ok',
      source: 'tauri_wsl_installer',
      restartRequired: true,
      message: '需要重启。',
    })).toBe(true)
    expect(isTauriInstallResponse({
      status: 'error',
      source: 'tauri_wsl_installer',
      restartRequired: false,
      message: '已取消。',
      error: { code: 'wsl_install_uac_cancelled', message: '已取消。' },
    })).toBe(true)
  })

  it('rejects missing, unknown, and success-shaped malformed responses', () => {
    expect(isTauriInstallResponse(undefined)).toBe(false)
    expect(isTauriInstallResponse({ status: 'ok', restartRequired: false, message: '完成。' })).toBe(false)
    expect(isTauriInstallResponse({
      status: 'ok', source: 'tauri_wsl_installer', restartRequired: 'no', message: '完成。',
    })).toBe(false)
    expect(isTauriInstallResponse({ status: 'maybe', source: 'tauri_wsl_installer' })).toBe(false)
  })
})
