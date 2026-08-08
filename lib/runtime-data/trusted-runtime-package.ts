/** 运行包只能来自产品内置并审核过的 manifest，绝不接受页面传入 URL。 */
export type RuntimePackageId = 'indextts2' | 'koubo-runtime'
export type RuntimePackageDownloadPhase = 'source_unconfigured' | 'ready' | 'downloading' | 'verifying' | 'failed' | 'importing' | 'installed'

export interface TrustedRuntimePackageManifest {
  packageId: RuntimePackageId
  displayName: string
  source: 'bundled_trusted_manifest'
  downloadUrl: string
  fileName: string
  sizeBytes: number
  sha256: string
}

export interface RuntimePackageDownloadState {
  packageId: RuntimePackageId
  phase: RuntimePackageDownloadPhase
  receivedBytes: number
  totalBytes: number | null
  error?: { code: 'source_unconfigured' | 'download_failed' | 'size_mismatch' | 'sha256_mismatch'; message: string }
}

// 尚无可公开分发的授权包；发布仓库就绪时必须将 URL、大小、SHA-256 一起固化在此处。
const TRUSTED_RELEASES: Partial<Record<RuntimePackageId, TrustedRuntimePackageManifest>> = {}

export function trustedRuntimePackageManifest(packageId: RuntimePackageId) { return TRUSTED_RELEASES[packageId] ?? null }

export function initialRuntimePackageDownloadState(packageId: RuntimePackageId): RuntimePackageDownloadState {
  const manifest = trustedRuntimePackageManifest(packageId)
  if (manifest) return { packageId, phase: 'ready', receivedBytes: 0, totalBytes: manifest.sizeBytes }
  return { packageId, phase: 'source_unconfigured', receivedBytes: 0, totalBytes: null, error: { code: 'source_unconfigured', message: '尚未配置经过授权和校验的官方运行包发布源，不能安全地自动下载。' } }
}

export function validateTrustedRuntimePackage(input: { manifest: TrustedRuntimePackageManifest; sizeBytes: number; sha256: string }) {
  if (input.sizeBytes !== input.manifest.sizeBytes) return { ok: false as const, code: 'size_mismatch' as const }
  if (input.sha256.toLowerCase() !== input.manifest.sha256.toLowerCase()) return { ok: false as const, code: 'sha256_mismatch' as const }
  return { ok: true as const }
}
