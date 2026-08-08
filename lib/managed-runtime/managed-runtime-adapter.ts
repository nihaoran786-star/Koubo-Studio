import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  MANAGED_RUNTIME_API_URL,
  MANAGED_RUNTIME_HEALTH_URL,
  MANAGED_RUNTIME_MANIFEST_PATH,
  MANAGED_RUNTIME_NAME,
  type ManagedRuntimeCommandResult,
  type ManagedRuntimeDistro,
  type ManagedRuntimeManifest,
  type ManagedRuntimeProbe,
} from './managed-runtime-types'

const LIST_ARGS = ['--list', '--verbose'] as const
const MANIFEST_ARGS = [
  '--distribution',
  MANAGED_RUNTIME_NAME,
  '--exec',
  'cat',
  MANAGED_RUNTIME_MANIFEST_PATH,
] as const

export type ManagedRuntimeCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<ManagedRuntimeCommandResult>

export type ManagedRuntimeHealthProbe = (url: string, manifest: ManagedRuntimeManifest) => Promise<{
  checked: boolean
  ok: boolean
  statusCode: number | null
}>

export async function probeManagedRuntime({
  runner = runManagedRuntimeCommand,
  healthProbe = probeLoopbackHealth,
  systemRoot = process.env.SystemRoot || 'C:\\Windows',
}: {
  runner?: ManagedRuntimeCommandRunner
  healthProbe?: ManagedRuntimeHealthProbe
  systemRoot?: string
} = {}): Promise<ManagedRuntimeProbe> {
  const executable = path.win32.join(systemRoot, 'System32', 'wsl.exe')
  const list = await runner(executable, LIST_ARGS)
  const distro = list.ok ? findManagedRuntimeDistro(list.stdout) : null

  if (!distro || distro.state !== 'running' || distro.wslVersion !== 2) {
    return {
      list,
      distro,
      manifestCommand: null,
      manifest: null,
      health: { checked: false, ok: false, statusCode: null },
    }
  }

  const manifestCommand = await runner(executable, MANIFEST_ARGS)
  const manifest = parseManagedRuntimeManifest(manifestCommand)
  const health = manifest
    ? await healthProbe(MANAGED_RUNTIME_HEALTH_URL, manifest)
    : { checked: false, ok: false, statusCode: null }

  return { list, distro, manifestCommand, manifest, health }
}

export function parseManagedRuntimeManifest(
  result: ManagedRuntimeCommandResult,
): ManagedRuntimeManifest | null {
  if (!result.ok) return null
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>
    if (
      value.schemaVersion !== 1
      || value.name !== MANAGED_RUNTIME_NAME
      || typeof value.version !== 'string'
      || !value.version.trim()
      || value.apiUrl !== MANAGED_RUNTIME_API_URL
    ) return null
    return {
      schemaVersion: 1,
      name: MANAGED_RUNTIME_NAME,
      version: value.version.trim(),
      apiUrl: MANAGED_RUNTIME_API_URL,
    }
  } catch {
    return null
  }
}

export function parseWslVerboseList(output: string): ManagedRuntimeDistro[] {
  return output
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .flatMap((rawLine) => {
      const line = rawLine.replace(/^\s*\*\s*/, '').trim()
      if (!line || /^(NAME|名称)\s+/i.test(line)) return []

      const match = line.match(/^(\S+)\s+(.+?)\s+([12])\s*$/)
      if (!match) return []
      return [{
        name: match[1],
        state: normalizeDistroState(match[2]),
        wslVersion: Number(match[3]),
      } satisfies ManagedRuntimeDistro]
    })
}

export function findManagedRuntimeDistro(output: string) {
  return parseWslVerboseList(output).find(
    (distro) => distro.name.toLocaleLowerCase() === MANAGED_RUNTIME_NAME.toLocaleLowerCase(),
  ) ?? null
}

export function decodeManagedRuntimeOutput(value: Buffer | string) {
  if (typeof value === 'string') return value
  if (value.length === 0) return ''
  const hasUtf16LeBom = value[0] === 0xff && value[1] === 0xfe
  const sampleLength = Math.min(value.length, 200)
  let oddNuls = 0
  let oddBytes = 0
  for (let index = 1; index < sampleLength; index += 2) {
    oddBytes += 1
    if (value[index] === 0) oddNuls += 1
  }
  const looksUtf16Le = hasUtf16LeBom || (oddBytes > 0 && oddNuls / oddBytes > 0.3)
  return value.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
}

async function runManagedRuntimeCommand(
  executable: string,
  args: readonly string[],
): Promise<ManagedRuntimeCommandResult> {
  return new Promise((resolve) => {
    execFile(executable, [...args], {
      encoding: 'buffer',
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const value = error as (NodeJS.ErrnoException & { code?: string | number }) | null
      resolve({
        ok: !error,
        exitCode: error ? (typeof value?.code === 'number' ? value.code : null) : 0,
        stdout: decodeManagedRuntimeOutput(stdout),
        stderr: decodeManagedRuntimeOutput(stderr) || error?.message || '',
        errorCode: typeof value?.code === 'string' ? value.code : undefined,
      })
    })
  })
}

async function probeLoopbackHealth(url: string, manifest: ManagedRuntimeManifest) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    })
    const text = await readLimitedText(response, 16 * 1024)
    if (!response.ok || text === null) {
      return { checked: true, ok: false, statusCode: response.status }
    }
    const identity = JSON.parse(text) as Record<string, unknown>
    const ok = identity.schemaVersion === manifest.schemaVersion
      && identity.name === manifest.name
      && identity.version === manifest.version
      && identity.apiDialect === 'compatible_render'
    return { checked: true, ok, statusCode: response.status }
  } catch {
    return { checked: true, ok: false, statusCode: null }
  }
}

async function readLimitedText(response: Response, limit: number) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function normalizeDistroState(value: string): ManagedRuntimeDistro['state'] {
  const normalized = value.trim().toLocaleLowerCase()
  if (['running', '正在运行', '运行中', '运行'].includes(normalized)) return 'running'
  if (['stopped', '已停止', '停止', '已停机'].includes(normalized)) return 'stopped'
  return 'unknown'
}
