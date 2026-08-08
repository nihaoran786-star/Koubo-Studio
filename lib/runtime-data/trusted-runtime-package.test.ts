import { describe, expect, it } from 'vitest'
import { initialRuntimePackageDownloadState, validateTrustedRuntimePackage } from './trusted-runtime-package'

describe('trusted runtime package boundary', () => {
  it('does not download from an unconfigured source', () => {
    expect(initialRuntimePackageDownloadState('koubo-runtime')).toMatchObject({ phase: 'source_unconfigured', error: { code: 'source_unconfigured' } })
  })
  it('requires manifest size and sha256 before import', () => {
    const manifest = { packageId: 'indextts2' as const, displayName: 'IndexTTS2', source: 'bundled_trusted_manifest' as const, downloadUrl: 'https://trusted.invalid/IndexTTS2.tar', fileName: 'IndexTTS2.tar', sizeBytes: 12, sha256: 'a'.repeat(64) }
    expect(validateTrustedRuntimePackage({ manifest, sizeBytes: 11, sha256: manifest.sha256 })).toMatchObject({ ok: false, code: 'size_mismatch' })
    expect(validateTrustedRuntimePackage({ manifest, sizeBytes: 12, sha256: 'b'.repeat(64) })).toMatchObject({ ok: false, code: 'sha256_mismatch' })
  })
})
