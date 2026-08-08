import { Download, ShieldAlert } from 'lucide-react'
import { initialRuntimePackageDownloadState, type RuntimePackageId } from '@/lib/runtime-data/trusted-runtime-package'

export function RuntimePackageDownloadBoundary({ packageId, label }: { packageId: RuntimePackageId; label: string }) {
  const state = initialRuntimePackageDownloadState(packageId)
  return <div className="mt-3 rounded-xl border border-line/70 bg-secondary/35 p-3 text-xs"><div className="flex items-start gap-2"><Download className="mt-0.5 size-3.5 shrink-0" /><div><p className="font-medium">一键下载 {label}</p><p className="mt-1 leading-relaxed text-sub">{state.error?.message}</p></div></div><p className="mt-2 flex items-start gap-1.5 leading-relaxed text-sub"><ShieldAlert className="mt-0.5 size-3 shrink-0" />发布源接入后，只会使用内置可信 manifest 的固定地址，并校验下载大小和 SHA-256；失败可重试，校验通过后才调用现有安全导入流程。</p></div>
}
