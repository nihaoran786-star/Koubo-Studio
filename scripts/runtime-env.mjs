import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_ENV_FILES = ['.env.runtime.local', '.env.local']

export function loadRuntimeEnvFiles({
  cwd = process.cwd(),
  env = process.env,
  files = getRuntimeEnvFiles(env),
} = {}) {
  const loaded = {}
  const loadedFiles = []

  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(cwd, file)
    if (!fs.existsSync(filePath)) continue
    const parsed = parseRuntimeEnvFile(fs.readFileSync(filePath, 'utf8'))
    Object.assign(loaded, parsed)
    loadedFiles.push(filePath)
  }

  return {
    env: {
      ...loaded,
      ...env,
    },
    loadedFiles,
  }
}

export function getRuntimeEnvFiles(env = process.env) {
  const explicit = env.RUNTIME_ENV_FILE?.trim()
  if (!explicit) return DEFAULT_ENV_FILES
  return explicit
    .split(path.delimiter)
    .map((file) => file.trim())
    .filter(Boolean)
}

export function parseRuntimeEnvFile(content) {
  const result = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    result[key] = parseValue(rawValue)
  }
  return result
}

function parseValue(rawValue) {
  const value = rawValue.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  const commentIndex = value.indexOf(' #')
  return commentIndex >= 0 ? value.slice(0, commentIndex).trim() : value
}
