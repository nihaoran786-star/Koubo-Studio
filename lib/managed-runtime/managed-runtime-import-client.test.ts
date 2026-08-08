// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedRuntimeImportClient } from './managed-runtime-import-client'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

describe('managed runtime import client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  })

  it('verifies and forwards the native lowercase SHA-256', async () => {
    const sha256 = '0123456789abcdef'.repeat(4)
    mocks.invoke.mockResolvedValue({
      status: 'ok',
      source: 'tauri_koubo_runtime_importer',
      version: '2026.07.0',
      sha256,
      message: '已导入。',
    })

    await expect(createManagedRuntimeImportClient().importPackage()).resolves.toEqual({
      status: 'ok',
      source: 'managed_wsl_action',
      version: '2026.07.0',
      sha256,
      message: '已导入。',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('import_koubo_runtime')
  })

  it.each([
    ['missing', undefined],
    ['uppercase', 'ABCDEF0123456789'.repeat(4)],
    ['short', 'a'.repeat(63)],
  ])('rejects an invalid native digest: %s', async (_label, sha256) => {
    mocks.invoke.mockResolvedValue({ status: 'ok', version: null, sha256 })

    await expect(createManagedRuntimeImportClient().importPackage()).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalid_response' },
    })
  })

  it('requires and forwards an explicit null digest when selection is cancelled', async () => {
    mocks.invoke.mockResolvedValue({ status: 'cancelled', sha256: null })

    await expect(createManagedRuntimeImportClient().importPackage()).resolves.toEqual({
      status: 'cancelled',
      source: 'managed_wsl_action',
      sha256: null,
    })

    mocks.invoke.mockResolvedValue({ status: 'cancelled' })
    await expect(createManagedRuntimeImportClient().importPackage()).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalid_response' },
    })
  })

  it('preserves stable native import errors', async () => {
    mocks.invoke.mockRejectedValue({
      code: 'package_checksum_mismatch',
      message: '运行包摘要不一致。',
    })

    await expect(createManagedRuntimeImportClient().importPackage()).resolves.toEqual({
      status: 'error',
      source: 'managed_wsl_action',
      error: { code: 'package_checksum_mismatch', message: '运行包摘要不一致。' },
    })
  })

  it('invokes the fixed parameterless uninstall command and accepts absent', async () => {
    mocks.invoke.mockResolvedValue({ status: 'absent', message: '已移除。' })

    await expect(createManagedRuntimeImportClient().uninstallRuntime()).resolves.toEqual({
      status: 'ok',
      source: 'managed_wsl_action',
      message: '已移除。',
      version: null,
      sha256: null,
    })
    expect(mocks.invoke).toHaveBeenCalledWith('uninstall_koubo_runtime')
  })

  it('keeps native uninstall cancellation distinct from success', async () => {
    mocks.invoke.mockResolvedValue({ status: 'cancelled', message: '已取消移除。' })

    await expect(createManagedRuntimeImportClient().uninstallRuntime()).resolves.toEqual({
      status: 'cancelled',
      source: 'managed_wsl_action',
      sha256: null,
      message: '已取消移除。',
    })
  })
})
