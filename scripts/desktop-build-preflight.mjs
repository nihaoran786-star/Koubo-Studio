import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { findForbiddenBundledContent } from './prepare-desktop-backend-bundle.mjs'

const MODEL_WEIGHT_EXTENSIONS = new Set([
  '.ckpt',
  '.engine',
  '.onnx',
  '.pt',
  '.pth',
  '.safetensors',
])
const MANAGED_RUNTIME_SEGMENT = /^koubo[-_. ]?runtime$/i
const HACK_RUNTIME_SEGMENT = /^heygem-linux-python-hack$/i
const BRANDED_RUNTIME_SEGMENT = /^(?:HeyGem|Duix(?:-Avatar)?)$/

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/')
}

export function findBundledRuntimeAssets(resourcesDir) {
  if (!existsSync(resourcesDir)) {
    return []
  }

  const matches = new Set()

  function visit(currentPath, relativePath = '') {
    const entries = readdirSync(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name
      const normalizedPath = normalizeRelativePath(entryRelativePath)
      const pathSegments = entryRelativePath.split(path.sep)
      const isExplicitRuntimePath = pathSegments.some((segment) => {
        return (
          MANAGED_RUNTIME_SEGMENT.test(segment) ||
          HACK_RUNTIME_SEGMENT.test(segment) ||
          BRANDED_RUNTIME_SEGMENT.test(segment)
        )
      })

      if (isExplicitRuntimePath) {
        matches.add(normalizedPath)
      }

      if (entry.isDirectory()) {
        visit(path.join(currentPath, entry.name), entryRelativePath)
        continue
      }

      const lowerName = entry.name.toLowerCase()
      const extension = path.extname(lowerName)
      const isRuntimeTar =
        /koubo[-_. ]?runtime.*\.tar(?:\.(?:gz|xz|zst))?$/i.test(entry.name) ||
        (isExplicitRuntimePath && /\.(?:tar|tar\.gz|tar\.xz|tar\.zst|tgz)$/i.test(entry.name))

      if (
        MODEL_WEIGHT_EXTENSIONS.has(extension) ||
        isRuntimeTar ||
        (extension === '.so' && isExplicitRuntimePath)
      ) {
        matches.add(normalizedPath)
      }
    }
  }

  visit(resourcesDir)
  return [...matches].sort()
}

export function checkDesktopBuildPreflight(env = process.env, root = process.cwd()) {
  const resourcesDir = path.join(root, 'src-tauri', 'resources')
  const runtimeAssets = findBundledRuntimeAssets(resourcesDir)
  if (runtimeAssets.length > 0) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_bundle_contains_runtime_assets',
        message:
          `桌面资源包含不得随免费 App 打包的数字人运行时、模型权重或 Linux 二进制：${runtimeAssets.slice(0, 12).join(', ')}`,
      },
    }
  }

  if (env.DESKTOP_SIDECAR_READY === '1') {
    return {
      status: 'ok',
      mode: 'sidecar',
    }
  }

  if (env.ALLOW_UNSUPPORTED_DESKTOP_STATIC_EXPORT === '1') {
    return {
      status: 'ok',
      mode: 'unsupported_static_export',
      warning: 'ALLOW_UNSUPPORTED_DESKTOP_STATIC_EXPORT is set. Desktop API-backed flows will not work.',
    }
  }

  const backendResourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
  const nodePath = path.join(backendResourceDir, process.platform === 'win32' ? 'node.exe' : 'node')
  const serverPath = path.join(backendResourceDir, 'server.js')
  const playwrightCorePath = path.join(backendResourceDir, 'node_modules', 'playwright-core', 'package.json')
  const forbiddenContent = findForbiddenBundledContent(backendResourceDir)
  if (forbiddenContent.length > 0) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_bundle_contains_forbidden_content',
        message: `桌面资源包含禁止打包的环境文件、源码、测试或本机内容：${forbiddenContent.slice(0, 12).join(', ')}`,
      },
    }
  }
  const bundledBrowserBinaries = [
    path.join(backendResourceDir, 'node_modules', 'playwright-core', '.local-browsers'),
    path.join(backendResourceDir, 'node_modules', 'playwright', '.local-browsers'),
    path.join(backendResourceDir, 'ms-playwright'),
  ].filter(existsSync)
  if (bundledBrowserBinaries.length > 0) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_bundle_contains_browser_binaries',
        message: '桌面资源意外包含浏览器二进制；发布功能必须复用系统 Chrome/Edge。',
      },
    }
  }
  if (existsSync(nodePath) && existsSync(serverPath) && !existsSync(playwrightCorePath)) {
    return {
      status: 'failed',
      error: {
        code: 'desktop_browser_runtime_missing',
        message: '桌面资源缺少 playwright-core，无法启动受监督的可见浏览器发布。',
      },
    }
  }
  if (existsSync(nodePath) && existsSync(serverPath)) {
    return {
      status: 'ok',
      mode: 'resource_sidecar',
      nodePath,
      serverPath,
    }
  }

  return {
    status: 'failed',
    error: {
      code: 'desktop_sidecar_missing',
      message:
        '桌面生产包还缺少 local backend/sidecar 承载 Next API route。请先完成 052，再运行 desktop:build。',
    },
  }
}

export function runDesktopBuildPreflight({
  env = process.env,
  root = process.cwd(),
  logger = console,
} = {}) {
  const result = checkDesktopBuildPreflight(env, root)

  if (result.status === 'ok') {
    if (result.warning) {
      logger.warn(result.warning)
    } else {
      logger.log(`Desktop build preflight passed: ${result.mode}`)
    }
    return result
  }

  logger.error(`Desktop build preflight failed (${result.error.code}): ${result.error.message}`)
  logger.error('Current desktop shell depends on API-backed flows: AI Provider, IndexTTS2, HeyGem, post-production, publish.')
  logger.error('Use pnpm smoke:desktop-backend for local backend checks while sidecar packaging is unfinished.')
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runDesktopBuildPreflight()
  if (result.status === 'failed') {
    process.exitCode = 1
  }
}
