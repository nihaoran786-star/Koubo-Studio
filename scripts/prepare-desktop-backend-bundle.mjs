import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIN_DESKTOP_BACKEND_NODE_VERSION,
  resolveDesktopNodeRuntime,
} from './desktop-node-runtime.mjs'

export { MIN_DESKTOP_BACKEND_NODE_VERSION }

const PACKAGED_ROOT_ALLOWLIST = new Set([
  '.next',
  'agent-resources',
  'node_modules',
  'public',
  'package.json',
  'server.js',
  'node',
  'node.exe',
])

export function prepareDesktopBackendBundle({
  root = process.cwd(),
  nodePath = process.execPath,
  getNodeVersion = readNodeVersion,
} = {}) {
  const standaloneDir = path.join(root, '.next', 'standalone')
  const serverPath = path.join(standaloneDir, 'server.js')
  const nextStaticDir = path.join(root, '.next', 'static')
  const publicDir = path.join(root, 'public')
  const resourceDir = path.join(root, 'src-tauri', 'resources', 'koubo-backend')
  const releaseResourceDirs = [
    path.join(root, 'src-tauri', '.target', 'release', 'resources', 'koubo-backend'),
    path.join(root, 'src-tauri', 'target', 'release', 'resources', 'koubo-backend'),
  ]
  const bundledNodePath = path.join(resourceDir, process.platform === 'win32' ? 'node.exe' : 'node')

  if (!existsSync(serverPath)) {
    return {
      status: 'failed',
      error: {
        code: 'standalone_server_missing',
        message: '缺少 .next/standalone/server.js。请先运行 pnpm build:desktop:backend。',
      },
    }
  }

  if (!existsSync(nodePath)) {
    return {
      status: 'failed',
      error: {
        code: 'node_runtime_missing',
        message: `Node runtime 不存在：${nodePath}`,
      },
    }
  }

  const nodeVersion = getNodeVersion(nodePath)
  if (nodeVersion.status !== 'ok') {
    return nodeVersion
  }

  if (!isSupportedNodeVersion(nodeVersion.version)) {
    return {
      status: 'failed',
      error: {
        code: 'node_runtime_unsupported',
        message:
          `桌面本地后端需要打包 Node >= ${MIN_DESKTOP_BACKEND_NODE_VERSION}，` +
          `当前打包 runtime 是 ${nodeVersion.version}。请设置 DESKTOP_BACKEND_NODE_PATH 指向 Node 22.19.0+。`,
      },
      nodePath,
      nodeVersion: nodeVersion.version,
    }
  }

  const nodeRuntime = preserveNodeRuntimeIfNeeded({ nodePath, resourceDir })

  try {
    // Tauri copies resources into its release directory without removing files
    // that disappeared from the source. Clear only this app-owned backend copy
    // so an old node_modules/.pnpm tree or local runtime state cannot survive.
    for (const releaseResourceDir of releaseResourceDirs) {
      rmSync(releaseResourceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    }
    rmSync(resourceDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    mkdirSync(resourceDir, { recursive: true })
    copyDesktopBundleTree({
      source: standaloneDir,
      destination: resourceDir,
      allowedSourceRoots: [standaloneDir, path.join(root, 'node_modules')],
      destinationRoot: resourceDir,
    })
    removeNonRuntimeRootEntries(resourceDir)
    materializePnpmRuntimePackages(path.join(resourceDir, 'node_modules'), resourceDir)
    prunePackagedRuntime(path.join(resourceDir, 'node_modules'))
    cpSync(nodeRuntime.sourcePath, bundledNodePath)
  } finally {
    nodeRuntime.cleanup()
  }

  if (existsSync(nextStaticDir)) {
    copyDesktopBundleTree({
      source: nextStaticDir,
      destination: path.join(resourceDir, '.next', 'static'),
      allowedSourceRoots: [nextStaticDir],
      destinationRoot: resourceDir,
    })
  }
  if (existsSync(publicDir)) {
    copyDesktopBundleTree({
      source: publicDir,
      destination: path.join(resourceDir, 'public'),
      allowedSourceRoots: [publicDir],
      destinationRoot: resourceDir,
    })
  }

  // Source maps can embed the original TypeScript/JavaScript source in
  // sourcesContent. They are not needed by the production backend.
  removeSourceMaps(resourceDir)

  assertNoBundledRuntimeState(resourceDir)

  return {
    status: 'ok',
    resourceDir,
    serverPath: path.join(resourceDir, 'server.js'),
    nodePath: bundledNodePath,
    nodeVersion: nodeVersion.version,
  }
}

function removeNonRuntimeRootEntries(resourceDir) {
  for (const entry of readdirSync(resourceDir)) {
    if (PACKAGED_ROOT_ALLOWLIST.has(entry)) continue
    rmSync(path.join(resourceDir, entry), { recursive: true, force: true })
  }

  for (const relativePath of [
    'node_modules/playwright-core/.local-browsers',
    'node_modules/playwright/.local-browsers',
  ]) {
    rmSync(path.join(resourceDir, relativePath), { recursive: true, force: true })
  }
}

function assertNoBundledRuntimeState(resourceDir) {
  const found = findForbiddenBundledContent(resourceDir)
  if (found.length > 0) {
    throw new Error(`Desktop bundle contains forbidden content: ${found.join(', ')}`)
  }
}

export function findForbiddenBundledContent(resourceDir) {
  if (!existsSync(resourceDir)) return []

  const found = []
  for (const entry of readdirSync(resourceDir)) {
    if (!PACKAGED_ROOT_ALLOWLIST.has(entry)) found.push(entry)
  }
  findForbiddenFiles(resourceDir, resourceDir, found)
  return found
}

function findForbiddenFiles(resourceDir, directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    const relativePath = path.relative(resourceDir, entryPath)
    if (entry.isDirectory()) {
      findForbiddenFiles(resourceDir, entryPath, found)
      continue
    }
    if (entry.isFile() && (entry.name === '.env' || entry.name.startsWith('.env.') || entry.name.endsWith('.map'))) {
      found.push(relativePath)
    }
  }
}

function preserveNodeRuntimeIfNeeded({ nodePath, resourceDir }) {
  if (!isInsidePath(nodePath, resourceDir)) {
    return {
      sourcePath: nodePath,
      cleanup: () => undefined,
    }
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'koubo-node-runtime-'))
  const sourcePath = path.join(tempDir, path.basename(nodePath))
  cpSync(nodePath, sourcePath)
  return {
    sourcePath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  }
}

function isInsidePath(filePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(filePath))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function copyDesktopBundleTree({
  source,
  destination,
  allowedSourceRoots,
  destinationRoot,
  ancestorCanonicalPaths = new Set(),
}) {
  const canonicalSource = realpathSync(source)
  const canonicalAllowedSourceRoots = allowedSourceRoots
    .filter((allowedRoot) => existsSync(allowedRoot))
    .map((allowedRoot) => realpathSync(allowedRoot))

  if (!canonicalAllowedSourceRoots.some((allowedRoot) => isPathInsideOrEqual(canonicalSource, allowedRoot))) {
    throw createDesktopBundleError(
      'desktop_bundle_source_escape',
      `桌面资源源路径越过允许根目录：${source}`,
    )
  }

  if (!isPathInsideOrEqual(destination, destinationRoot)) {
    throw createDesktopBundleError(
      'desktop_bundle_destination_escape',
      `桌面资源目标路径越过资源目录：${destination}`,
    )
  }

  const sourceNode = lstatSync(source)
  const resolvedNode = sourceNode.isSymbolicLink() ? statSync(canonicalSource) : sourceNode

  if (resolvedNode.isFile()) {
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(canonicalSource, destination)
    return
  }

  if (!resolvedNode.isDirectory()) {
    throw createDesktopBundleError(
      'desktop_bundle_source_unsupported',
      `桌面资源包含不支持的节点类型：${source}`,
    )
  }

  const canonicalKey = normalizePathForComparison(canonicalSource)
  if (ancestorCanonicalPaths.has(canonicalKey)) {
    throw createDesktopBundleError(
      'desktop_bundle_source_cycle',
      `桌面资源源路径包含循环链接：${source}`,
    )
  }

  const childAncestors = new Set(ancestorCanonicalPaths)
  childAncestors.add(canonicalKey)
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(canonicalSource)) {
    copyDesktopBundleTree({
      source: path.join(canonicalSource, entry),
      destination: path.join(destination, entry),
      allowedSourceRoots: canonicalAllowedSourceRoots,
      destinationRoot,
      ancestorCanonicalPaths: childAncestors,
    })
  }
}

function createDesktopBundleError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPathInsideOrEqual(filePath, parentPath) {
  const normalizedFilePath = normalizePathForComparison(filePath)
  const normalizedParentPath = normalizePathForComparison(parentPath)
  const relative = path.relative(normalizedParentPath, normalizedFilePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizePathForComparison(filePath) {
  const normalized = path.resolve(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function materializePnpmRuntimePackages(nodeModulesDir, destinationRoot) {
  const pnpmDir = path.join(nodeModulesDir, '.pnpm')
  if (!existsSync(pnpmDir)) return

  for (const entry of readdirSync(pnpmDir)) {
    const packageNodeModules = path.join(pnpmDir, entry, 'node_modules')
    if (!existsSync(packageNodeModules)) continue

    for (const packageEntry of readdirSync(packageNodeModules)) {
      if (packageEntry.startsWith('.')) continue

      if (packageEntry.startsWith('@')) {
        const scopeDir = path.join(packageNodeModules, packageEntry)
        for (const scopedPackage of readdirSync(scopeDir)) {
          copyRuntimePackage({
            source: path.join(scopeDir, scopedPackage),
            destination: path.join(nodeModulesDir, packageEntry, scopedPackage),
            nodeModulesDir,
            destinationRoot,
          })
        }
        continue
      }

      copyRuntimePackage({
        source: path.join(packageNodeModules, packageEntry),
        destination: path.join(nodeModulesDir, packageEntry),
        nodeModulesDir,
        destinationRoot,
      })
    }
  }

  // All runtime packages now exist at ordinary node_modules paths. Keeping
  // pnpm's content-addressed copy duplicates the bundle and can exceed the
  // Windows/NSIS path limit on deeply nested declaration source maps.
  rmSync(pnpmDir, { recursive: true, force: true })
}

function copyRuntimePackage({ source, destination, nodeModulesDir, destinationRoot }) {
  if (existsSync(destination)) return
  mkdirSync(path.dirname(destination), { recursive: true })
  copyDesktopBundleTree({
    source,
    destination,
    allowedSourceRoots: [nodeModulesDir],
    destinationRoot,
  })
}

function prunePackagedRuntime(nodeModulesDir) {
  if (process.platform === 'win32') {
    const imgDir = path.join(nodeModulesDir, '@img')
    if (existsSync(imgDir)) {
      for (const entry of readdirSync(imgDir)) {
        if (entry !== 'colour' && entry !== 'sharp-win32-x64') {
          rmSync(path.join(imgDir, entry), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
        }
      }
    }
  }

  removeSourceMaps(nodeModulesDir)
}

function removeSourceMaps(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      removeSourceMaps(entryPath)
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      unlinkSync(entryPath)
    }
  }
}

export function runPrepareDesktopBackendBundle({
  root = process.cwd(),
  env = process.env,
  resolveNode = resolveDesktopNodeRuntime,
  prepare = prepareDesktopBackendBundle,
  logger = console,
} = {}) {
  const node = resolveNode({ root, env })
  if (node.status !== 'ok') {
    logger.error(`Desktop backend bundle failed (${node.error.code}): ${node.error.message}`)
    return node
  }
  const result = prepare({ root, nodePath: node.nodePath })
  if (result.status === 'ok') {
    logger.log(`Desktop backend bundle ready: ${result.resourceDir}`)
    return result
  }

  logger.error(`Desktop backend bundle failed (${result.error.code}): ${result.error.message}`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = runPrepareDesktopBackendBundle()
  if (result.status === 'failed') {
    process.exitCode = 1
  }
}

function readNodeVersion(nodePath) {
  const result = spawnSync(nodePath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.error || result.status !== 0) {
    const message = result.error?.message || result.stderr || `exit code ${result.status}`
    return {
      status: 'failed',
      error: {
        code: 'node_runtime_version_check_failed',
        message: `无法读取 Node runtime 版本：${message}`,
      },
      nodePath,
    }
  }

  const version = String(result.stdout || result.stderr).trim().replace(/^v/i, '')
  if (!version) {
    return {
      status: 'failed',
      error: {
        code: 'node_runtime_version_check_failed',
        message: '无法读取 Node runtime 版本：输出为空。',
      },
      nodePath,
    }
  }

  return {
    status: 'ok',
    version,
  }
}

function isSupportedNodeVersion(version) {
  const current = parseVersion(version)
  const minimum = parseVersion(MIN_DESKTOP_BACKEND_NODE_VERSION)

  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true
    if (current[index] < minimum[index]) return false
  }

  return true
}

function parseVersion(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}
