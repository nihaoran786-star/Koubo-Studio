import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function checkDesktopBackendArtifact({
  root = process.cwd(),
} = {}) {
  const serverPath = path.join(root, '.next', 'standalone', 'server.js')
  const staticPath = path.join(root, '.next', 'static')

  if (!existsSync(serverPath)) {
    return {
      status: 'failed',
      error: {
        code: 'sidecar_artifact_missing',
        message: '缺少 .next/standalone/server.js。请先运行 pnpm build:desktop:backend。',
      },
      serverPath,
    }
  }

  return {
    status: 'ok',
    mode: 'next_standalone',
    serverPath,
    staticPath,
  }
}

export function runDesktopBackendArtifactPreflight({
  root = process.cwd(),
  logger = console,
} = {}) {
  const result = checkDesktopBackendArtifact({ root })

  if (result.status === 'ok') {
    logger.log(`Desktop backend artifact ready: ${result.serverPath}`)
    return result
  }

  logger.error(`Desktop backend artifact missing (${result.error.code}): ${result.error.message}`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = runDesktopBackendArtifactPreflight()
  if (result.status === 'failed') {
    process.exitCode = 1
  }
}
