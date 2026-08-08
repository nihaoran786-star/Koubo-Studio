import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getRuntimeSettingsRoot } from '@/lib/runtime-data/runtime-data-root'

export interface OpenChatCutSettings {
  version: 2
  bearerToken?: string
  cdpPort?: number
}

const defaults: OpenChatCutSettings = { version: 2 }

export async function readOpenChatCutSettings(): Promise<OpenChatCutSettings> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as Record<string, unknown>
    if (parsed.version !== 1 && parsed.version !== 2) return defaults
    return {
      version: 2,
      ...(typeof parsed.bearerToken === 'string' && parsed.bearerToken.trim()
        ? { bearerToken: parsed.bearerToken.trim() }
        : {}),
      ...(Number.isInteger(parsed.cdpPort) && Number(parsed.cdpPort) >= 1024 && Number(parsed.cdpPort) <= 65535
        ? { cdpPort: Number(parsed.cdpPort) }
        : {}),
    }
  } catch {
    return defaults
  }
}

export async function writeOpenChatCutSettings(settings: OpenChatCutSettings) {
  const root = getRuntimeSettingsRoot()
  await fs.mkdir(root, { recursive: true })
  const target = settingsPath()
  const temporary = path.join(root, `.openchatcut-${randomUUID()}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await fs.rename(temporary, target)
}

function settingsPath() {
  return path.join(getRuntimeSettingsRoot(), 'openchatcut.json')
}
