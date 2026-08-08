import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHeyGemSmokeConfig } from './heygem-smoke-preflight.mjs'
import { readIndexTTS2SmokeConfig } from './indextts2-smoke-preflight.mjs'

export async function runDigitalHumanChainSmokePreflight({
  env = process.env,
  cwd = process.cwd(),
  logger = console,
} = {}) {
  if (env.RUN_DIGITAL_HUMAN_CHAIN_SMOKE !== '1') {
    logger.log('Digital-human chain smoke skipped. Set RUN_DIGITAL_HUMAN_CHAIN_SMOKE=1 to verify approved script -> IndexTTS2 audio -> HeyGem/Duix render.')
    return { status: 'skipped', reason: 'disabled' }
  }

  const indexConfig = readIndexTTS2SmokeConfig({ ...env, RUN_INDEXTTS2_INTEGRATION: '1' }, cwd)
  const heygemConfig = readHeyGemSmokeConfig({ ...env, RUN_HEYGEM_INTEGRATION: '1' })
  const missing = []

  if (!indexConfig.referenceAudioPath) missing.push('INDEXTTS2_REFERENCE_AUDIO')
  if (!indexConfig.runtimeRoot) missing.push('INDEXTTS2_RUNTIME_ROOT')
  if (!indexConfig.scriptPath) missing.push('INDEXTTS2_SCRIPT_PATH')

  if (!heygemConfig.apiUrl && !heygemConfig.scriptPath) {
    missing.push('DUIX_AVATAR_API_URL or DUIX_AVATAR_SCRIPT_PATH')
  }
  if (heygemConfig.apiDialect !== 'compatible_render' && heygemConfig.apiDialect !== 'duix_face2face') {
    return fail(logger, 'invalid_api_dialect', [
      `DUIX_AVATAR_API_DIALECT/HEYGEM_API_DIALECT is not supported: ${heygemConfig.apiDialect}`,
      'Use compatible_render or duix_face2face.',
    ])
  }
  if (heygemConfig.apiDialect === 'duix_face2face') {
    if (!heygemConfig.resultRoot) missing.push('DUIX_AVATAR_RESULT_ROOT or HEYGEM_RESULT_ROOT')
    if (!readAvatarAsset(env)) missing.push('DUIX_AVATAR_INTEGRATION_AVATAR_ASSET or HEYGEM_INTEGRATION_AVATAR_ASSET')
    if (!heygemConfig.publicAssetBaseUrl && heygemConfig.hostDataRoot && !readWorkspacesRoot(env)) {
      missing.push('KOUBO_WORKSPACES_ROOT')
    }
  }

  if (missing.length > 0) {
    return fail(logger, 'missing_chain_runtime_config', [
      `Missing digital-human chain runtime config: ${missing.join(', ')}`,
      'Set the missing values in .env.runtime.local or export them before running pnpm smoke:digital-human-chain.',
    ])
  }

  const fileChecks = [
    checkReadableFile(indexConfig.referenceAudioPath, 'INDEXTTS2_REFERENCE_AUDIO'),
    checkReadableDirectory(indexConfig.runtimeRoot, 'INDEXTTS2_RUNTIME_ROOT'),
    checkReadableFile(indexConfig.scriptPath, 'INDEXTTS2_SCRIPT_PATH'),
  ].filter(Boolean)

  if (heygemConfig.resultRoot) {
    fileChecks.push(checkReadableDirectory(heygemConfig.resultRoot, 'DUIX_AVATAR_RESULT_ROOT/HEYGEM_RESULT_ROOT'))
  }
  const workspacesRoot = readWorkspacesRoot(env)
  if (workspacesRoot) {
    fileChecks.push(checkReadableDirectory(workspacesRoot, 'KOUBO_WORKSPACES_ROOT'))
    if (heygemConfig.apiDialect === 'duix_face2face' && heygemConfig.hostDataRoot) {
      const mappingCheck = checkWorkspacesRootInsideHostDataRoot(workspacesRoot, heygemConfig.hostDataRoot)
      if (mappingCheck) fileChecks.push(mappingCheck)
    }
  }
  const avatarAsset = readAvatarAsset(env)
  if (avatarAsset) {
    fileChecks.push(checkReadableFile(avatarAsset, 'DUIX_AVATAR_INTEGRATION_AVATAR_ASSET/HEYGEM_INTEGRATION_AVATAR_ASSET'))
    if (heygemConfig.apiDialect === 'duix_face2face') {
      const videoCheck = checkVideoFileExtension(avatarAsset)
      if (videoCheck) fileChecks.push(videoCheck)
    }
  }

  const failedCheck = fileChecks.find(Boolean)
  if (failedCheck) return fail(logger, failedCheck.reason, failedCheck.messages)

  logger.log('Digital-human chain smoke preflight passed.')
  return {
    status: 'ok',
    referenceAudioPath: indexConfig.referenceAudioPath,
    runtimeRoot: indexConfig.runtimeRoot,
    scriptPath: indexConfig.scriptPath,
    apiUrl: heygemConfig.apiUrl,
    apiDialect: heygemConfig.apiDialect,
    resultRoot: heygemConfig.resultRoot,
    avatarAsset,
  }
}

function readAvatarAsset(env) {
  return env.DUIX_AVATAR_INTEGRATION_AVATAR_ASSET?.trim() || env.HEYGEM_INTEGRATION_AVATAR_ASSET?.trim()
}

function readWorkspacesRoot(env) {
  return env.KOUBO_WORKSPACES_ROOT?.trim()
}

function checkReadableFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
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
        'Use a non-empty file.',
      ],
    }
  }
  return undefined
}

function checkReadableDirectory(dirPath, label) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return {
      reason: 'missing_directory',
      messages: [
        `${label} does not exist: ${dirPath}`,
        'Use an absolute path to a local directory that the current process can read.',
      ],
    }
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return {
      reason: 'invalid_directory',
      messages: [
        `${label} is not a directory: ${dirPath}`,
        'Use a directory, not a file.',
      ],
    }
  }
  return undefined
}

function checkVideoFileExtension(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(extension)) return undefined
  return {
    reason: 'invalid_avatar_video',
    messages: [
      `DUIX_AVATAR_INTEGRATION_AVATAR_ASSET must be a video file for duix_face2face mode: ${filePath}`,
      'Use a short face video such as .mp4; still images usually fail Duix preprocessing with format video error.',
    ],
  }
}

function checkWorkspacesRootInsideHostDataRoot(workspacesRoot, hostDataRoot) {
  const relative = path.relative(hostDataRoot, workspacesRoot)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return undefined
  return {
    reason: 'workspace_root_not_mounted',
    messages: [
      `KOUBO_WORKSPACES_ROOT must be inside DUIX_AVATAR_HOST_DATA_ROOT when Duix reads local files: ${workspacesRoot}`,
      `Current DUIX_AVATAR_HOST_DATA_ROOT/HEYGEM_HOST_DATA_ROOT: ${hostDataRoot}`,
    ],
  }
}

function fail(logger, reason, messages) {
  for (const message of messages) {
    logger.error(message)
  }
  return { status: 'failed', reason }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runDigitalHumanChainSmokePreflight()
  process.exit(result.status === 'failed' ? 1 : 0)
}
