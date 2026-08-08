import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const MIN_DESKTOP_BACKEND_NODE_VERSION = '22.19.0'

export function resolveDesktopNodeRuntime({
  root = process.cwd(),
  env = process.env,
  processExecPath = process.execPath,
  codexCandidates = getCodexBundledNodeCandidates(env),
  getNodeVersion = readNodeVersion,
} = {}) {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates = uniqueCandidates([
    { nodePath: env.DESKTOP_BACKEND_NODE_PATH?.trim(), source: 'explicit' },
    { nodePath: processExecPath, source: 'process' },
    { nodePath: path.join(root, 'src-tauri', 'resources', 'koubo-backend', executable), source: 'project_bundle' },
    ...codexCandidates.map((nodePath) => ({ nodePath, source: 'codex_bundle' })),
  ])
  const attempts = []

  for (const candidate of candidates) {
    if (!candidate.nodePath || !existsSync(candidate.nodePath)) {
      attempts.push({ ...candidate, status: 'missing' })
      continue
    }
    const versionResult = getNodeVersion(candidate.nodePath)
    if (versionResult.status !== 'ok') {
      attempts.push({ ...candidate, status: 'unreadable', error: versionResult.error })
      continue
    }
    if (!isSupportedNodeVersion(versionResult.version)) {
      attempts.push({ ...candidate, status: 'unsupported', nodeVersion: versionResult.version })
      continue
    }
    return { status: 'ok', ...candidate, nodeVersion: versionResult.version, attempts }
  }

  return {
    status: 'failed',
    error: {
      code: 'desktop_node_runtime_unavailable',
      message: `未找到 Node >= ${MIN_DESKTOP_BACKEND_NODE_VERSION}。可设置 DESKTOP_BACKEND_NODE_PATH 指向受支持的 node.exe。`,
    },
    attempts,
  }
}

export function getCodexBundledNodeCandidates(env = process.env) {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const candidates = []
  const localAppData = env.LOCALAPPDATA
  const programFiles = env.ProgramFiles || env.PROGRAMFILES
  const roots = [
    localAppData && path.join(localAppData, 'Programs', 'Codex'),
    localAppData && path.join(localAppData, 'OpenAI', 'Codex'),
    programFiles && path.join(programFiles, 'Codex'),
  ].filter(Boolean)
  for (const root of roots) {
    candidates.push(path.join(root, 'resources', executable))
    candidates.push(path.join(root, 'app', 'resources', executable))
    candidates.push(path.join(root, 'resources', 'node', executable))
  }

  const windowsApps = programFiles && path.join(programFiles, 'WindowsApps')
  if (windowsApps && existsSync(windowsApps)) {
    try {
      for (const entry of readdirSync(windowsApps).filter((name) => name.startsWith('OpenAI.Codex_')).sort().reverse()) {
        candidates.push(path.join(windowsApps, entry, 'app', 'resources', executable))
        candidates.push(path.join(windowsApps, entry, 'app', 'resources', 'node', executable))
      }
    } catch {
      // Microsoft Store app directories may be unreadable; other candidates remain usable.
    }
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))]
}

export function readNodeVersion(nodePath) {
  const result = spawnSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    return {
      status: 'failed',
      error: { code: 'node_runtime_version_check_failed', message: result.error?.message || String(result.stderr || `exit code ${result.status}`) },
    }
  }
  const version = String(result.stdout || result.stderr).trim().replace(/^v/i, '')
  return version
    ? { status: 'ok', version }
    : { status: 'failed', error: { code: 'node_runtime_version_check_failed', message: 'Node 版本输出为空。' } }
}

function uniqueCandidates(candidates) {
  const seen = new Set()
  return candidates.filter(({ nodePath }) => {
    if (!nodePath) return false
    const normalized = path.resolve(nodePath).toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).map((candidate) => ({ ...candidate, nodePath: path.resolve(candidate.nodePath) }))
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
