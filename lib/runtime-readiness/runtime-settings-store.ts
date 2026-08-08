import fs from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeReadinessProfileId } from './runtime-readiness-types'
import { getRuntimeSettingsRoot } from '@/lib/runtime-data/runtime-data-root'

const SETTINGS_FILE = 'runtime-settings.json'

export interface RuntimeSettings {
  profileId: RuntimeReadinessProfileId
}

export function createDefaultRuntimeSettings(): RuntimeSettings {
  return {
    profileId: 'base',
  }
}

export async function readRuntimeSettings(options: {
  root?: string
} = {}): Promise<RuntimeSettings> {
  try {
    const raw = await fs.readFile(settingsPath(options.root), 'utf8')
    return normalizeRuntimeSettings(JSON.parse(raw) as Partial<RuntimeSettings>)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createDefaultRuntimeSettings()
    }
    throw new RuntimeSettingsStoreError('运行环境设置无法读取或解析')
  }
}

export async function writeRuntimeSettings(
  settings: RuntimeSettings,
  options: { root?: string } = {},
): Promise<RuntimeSettings> {
  const normalized = normalizeRuntimeSettings(settings)
  const filePath = settingsPath(options.root)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

export function normalizeRuntimeSettings(settings: Partial<RuntimeSettings>): RuntimeSettings {
  return {
    profileId: normalizeRuntimeProfileId(settings.profileId),
  }
}

export function normalizeRuntimeProfileId(value: unknown): RuntimeReadinessProfileId {
  if (
    value === 'base' ||
    value === 'local_enhanced' ||
    value === 'publish_enhanced' ||
    value === 'remote_runtime' ||
    value === 'full'
  ) {
    return value
  }
  return createDefaultRuntimeSettings().profileId
}

export function isRuntimeProfileId(value: unknown): value is RuntimeReadinessProfileId {
  return (
    value === 'base' ||
    value === 'local_enhanced' ||
    value === 'publish_enhanced' ||
    value === 'remote_runtime' ||
    value === 'full'
  )
}

function settingsPath(root = getRuntimeSettingsRoot()) {
  return path.join(root, SETTINGS_FILE)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export class RuntimeSettingsStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeSettingsStoreError'
  }
}
