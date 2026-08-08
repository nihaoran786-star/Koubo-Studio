import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function isMainModule(metaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  return path.resolve(fileURLToPath(metaUrl)) === path.resolve(argvPath)
}
