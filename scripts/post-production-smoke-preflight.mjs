import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function readPostProductionSmokeConfig(env = process.env, cwd = process.cwd()) {
  return {
    enabled: env.RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE === '1',
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    outputProbeRoot: env.POST_PRODUCTION_SMOKE_OUTPUT_ROOT?.trim() ||
      path.join(cwd, 'data', 'workspaces'),
  }
}

export async function runPostProductionSmokePreflight({
  env = process.env,
  cwd = process.cwd(),
  logger = console,
  commandExists = defaultCommandExists,
} = {}) {
  const config = readPostProductionSmokeConfig(env, cwd)
  if (!config.enabled) {
    logger.log('Post-production local skill smoke skipped. Set RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE=1 to check the bundled video editing skill.')
    return { status: 'skipped', reason: 'disabled' }
  }

  for (const [label, command] of [
    ['ffmpeg', config.ffmpegPath],
    ['ffprobe', config.ffprobePath],
  ]) {
    const dependencyCheck = checkCommandOrFile(command, label, commandExists)
    if (dependencyCheck) return fail(logger, dependencyCheck.reason, dependencyCheck.messages)
  }

  if (isTemplateValue(config.outputProbeRoot)) {
    return fail(logger, 'placeholder_output_root', [
      `POST_PRODUCTION_SMOKE_OUTPUT_ROOT is still a template path: ${config.outputProbeRoot}`,
      'Set it to a real writable workspace root for smoke artifacts.',
    ])
  }
  const writeCheck = checkWritableDirectory(config.outputProbeRoot)
  if (writeCheck) return fail(logger, writeCheck.reason, writeCheck.messages)

  logger.log(`Post-production smoke preflight passed: ${config.outputProbeRoot}`)
  return {
    status: 'ok',
    outputProbeRoot: config.outputProbeRoot,
  }
}

function checkReadableFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return {
      reason: 'missing_file',
      messages: [
        `${label} does not exist: ${filePath}`,
        'Use an absolute path to a local file that the current process can read.',
      ],
    }
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    return {
      reason: 'invalid_file',
      messages: [
        `${label} is not a file: ${filePath}`,
        'Use a regular local file, not a directory.',
      ],
    }
  }
  if (stat.size <= 0) {
    return {
      reason: 'empty_file',
      messages: [
        `${label} is empty: ${filePath}`,
        'Use a non-empty script file.',
      ],
    }
  }
  return undefined
}

function isTemplateValue(value) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return false
  const slashNormalized = normalized.replaceAll('/', '\\')
  return (
    slashNormalized.includes('\\path\\to\\') ||
    normalized.includes('replace-with') ||
    normalized.includes('placeholder') ||
    normalized.includes('dummy') ||
    normalized.includes('example') ||
    normalized.startsWith('your-')
  )
}

function checkCommandOrFile(value, label, commandExists) {
  const looksLikePath = value.includes('/') || value.includes('\\') || path.isAbsolute(value)
  if (looksLikePath) {
    const check = checkReadableFile(value, label)
    return check
      ? {
          reason: `${label}_missing`,
          messages: check.messages,
        }
      : undefined
  }
  if (commandExists(value)) return undefined
  return {
    reason: `${label}_missing`,
    messages: [
      `${label} was not found on PATH: ${value}`,
      `Install ${label} or set ${label === 'ffmpeg' ? 'FFMPEG_PATH' : label === 'ffprobe' ? 'FFPROBE_PATH' : 'PATH'} to a valid executable.`,
    ],
  }
}

function checkWritableDirectory(root) {
  const probeDir = path.join(root, `.post-production-smoke-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const probeFile = path.join(probeDir, 'write-test.txt')
  try {
    fs.mkdirSync(probeDir, { recursive: true })
    fs.writeFileSync(probeFile, 'ok')
    fs.rmSync(probeDir, { recursive: true, force: true })
    return undefined
  } catch (error) {
    try {
      fs.rmSync(probeDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup.
    }
    return {
      reason: 'output_not_writable',
      messages: [
        `Post-production smoke output root is not writable: ${root}`,
        error instanceof Error ? error.message : String(error),
      ],
    }
  }
}

function defaultCommandExists(command) {
  const result = spawnSync(command, ['-version'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error
}

function fail(logger, reason, messages) {
  for (const message of messages) {
    logger.error(message)
  }
  return { status: 'failed', reason }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runPostProductionSmokePreflight()
  process.exit(result.status === 'failed' ? 1 : 0)
}
