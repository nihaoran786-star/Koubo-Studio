import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

export function readHeyGemSmokeConfig(env = process.env) {
  return {
    enabled: env.RUN_HEYGEM_INTEGRATION === '1',
    apiUrl: env.DUIX_AVATAR_API_URL?.trim() || env.HEYGEM_API_URL?.trim(),
    apiKey: env.DUIX_AVATAR_API_KEY?.trim() || env.HEYGEM_API_KEY?.trim(),
    apiDialect: env.DUIX_AVATAR_API_DIALECT?.trim() || env.HEYGEM_API_DIALECT?.trim() || 'compatible_render',
    publicAssetBaseUrl: env.DUIX_AVATAR_PUBLIC_ASSET_BASE_URL?.trim() || env.HEYGEM_PUBLIC_ASSET_BASE_URL?.trim(),
    resultRoot: env.DUIX_AVATAR_RESULT_ROOT?.trim() || env.HEYGEM_RESULT_ROOT?.trim(),
    hostDataRoot: env.DUIX_AVATAR_HOST_DATA_ROOT?.trim() || env.HEYGEM_HOST_DATA_ROOT?.trim(),
    containerDataRoot: env.DUIX_AVATAR_CONTAINER_DATA_ROOT?.trim() || env.HEYGEM_CONTAINER_DATA_ROOT?.trim(),
    scriptPath: env.DUIX_AVATAR_SCRIPT_PATH?.trim() || env.HEYGEM_SCRIPT_PATH?.trim(),
    audioPath: env.DUIX_AVATAR_INTEGRATION_AUDIO?.trim() || env.HEYGEM_INTEGRATION_AUDIO?.trim(),
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
    apiReachabilityTimeoutMs: Number(env.DUIX_AVATAR_API_REACHABILITY_TIMEOUT_MS || env.HEYGEM_API_REACHABILITY_TIMEOUT_MS) > 0
      ? Number(env.DUIX_AVATAR_API_REACHABILITY_TIMEOUT_MS || env.HEYGEM_API_REACHABILITY_TIMEOUT_MS)
      : 3000,
  }
}

export async function runHeyGemSmokePreflight({
  env = process.env,
  logger = console,
  commandExists = defaultCommandExists,
  checkApiReachable = defaultCheckApiReachable,
  checkDuixFace2FaceEndpoint = defaultCheckDuixFace2FaceEndpoint,
  probeAudioDuration = probeDurationWithFfprobe,
  probeAvatarDuration = probeDurationWithFfprobe,
} = {}) {
  const config = readHeyGemSmokeConfig(env)
  if (!config.enabled) {
    logger.log('Duix-Avatar / HeyGem runtime smoke skipped. Set RUN_HEYGEM_INTEGRATION=1 and DUIX_AVATAR_API_URL or DUIX_AVATAR_SCRIPT_PATH to check a real runtime.')
    return { status: 'skipped', reason: 'disabled' }
  }

  if (!config.apiUrl && !config.scriptPath) {
    return fail(logger, 'missing_runtime', [
      'DUIX_AVATAR_API_URL or DUIX_AVATAR_SCRIPT_PATH is required when RUN_HEYGEM_INTEGRATION=1.',
      'Use DUIX_AVATAR_API_URL for a Duix-Avatar/HeyGem-compatible HTTP backend, or DUIX_AVATAR_SCRIPT_PATH for a local PowerShell workflow.',
    ])
  }

  let normalizedApiUrl
  if (config.apiUrl) {
    if (config.apiDialect !== 'compatible_render' && config.apiDialect !== 'duix_face2face') {
      return fail(logger, 'invalid_api_dialect', [
        `DUIX_AVATAR_API_DIALECT/HEYGEM_API_DIALECT is not supported: ${config.apiDialect}`,
        'Use compatible_render for /render backends or duix_face2face for HeyGem/Duix /easy/submit + /easy/query backends.',
      ])
    }
    normalizedApiUrl = normalizeApiUrl(config.apiUrl)
    if (!normalizedApiUrl) {
      return fail(logger, 'invalid_api_url', [
        `DUIX_AVATAR_API_URL/HEYGEM_API_URL is not a real http(s) URL or is still a template placeholder: ${config.apiUrl}`,
        'Expected a backend base URL such as http://127.0.0.1:8383',
      ])
    }
    if (config.apiKey && isPlaceholderValue(config.apiKey)) {
      return fail(logger, 'placeholder_api_key', [
        'DUIX_AVATAR_API_KEY/HEYGEM_API_KEY is still a template placeholder.',
        'Replace it with a real key or leave it empty for local backends that do not require bearer auth.',
      ])
    }
    const reachable = await checkApiReachable(normalizedApiUrl, config.apiReachabilityTimeoutMs)
    if (!reachable) {
      return fail(logger, 'api_unreachable', [
        `DUIX_AVATAR_API_URL/HEYGEM_API_URL is not reachable: ${normalizedApiUrl}`,
        'Start the Duix-Avatar/HeyGem service or point DUIX_AVATAR_API_URL to a reachable compatible backend before running the real smoke.',
      ])
    }
    if (!config.apiKey) {
      logger.warn?.('DUIX_AVATAR_API_KEY/HEYGEM_API_KEY is not set. Continuing because some local Duix-Avatar/HeyGem-compatible backends do not require bearer auth.')
    }
    if (config.apiDialect === 'duix_face2face') {
      const endpoint = await checkDuixFace2FaceEndpoint(normalizedApiUrl, {
        apiKey: config.apiKey,
        timeoutMs: config.apiReachabilityTimeoutMs,
      })
      if (!endpoint.ok) {
        return fail(logger, endpoint.reason, endpoint.messages)
      }
      if (config.publicAssetBaseUrl) {
        const normalizedPublicAssetBaseUrl = normalizeApiUrl(config.publicAssetBaseUrl)
        if (!normalizedPublicAssetBaseUrl) {
          return fail(logger, 'invalid_public_asset_base_url', [
            `DUIX_AVATAR_PUBLIC_ASSET_BASE_URL/HEYGEM_PUBLIC_ASSET_BASE_URL is not a real http(s) URL or is still a template placeholder: ${config.publicAssetBaseUrl}`,
            'Set it to the public origin that can serve this app API, such as https://example.com',
          ])
        }
      } else {
        logger.warn?.('DUIX_AVATAR_PUBLIC_ASSET_BASE_URL/HEYGEM_PUBLIC_ASSET_BASE_URL is not set. Duix submit will fall back to local audio/avatar paths, which only works when Duix-Avatar can read the same filesystem.')
      }
      if (!config.resultRoot) {
        return fail(logger, 'missing_result_root', [
          'DUIX_AVATAR_RESULT_ROOT/HEYGEM_RESULT_ROOT is required when DUIX_AVATAR_API_DIALECT=duix_face2face.',
          'Set it to the local directory where HeyGem/Duix writes face2face result videos.',
        ])
      }
      if (!fs.existsSync(config.resultRoot) || !fs.statSync(config.resultRoot).isDirectory()) {
        return fail(logger, 'invalid_result_root', [
          `HEYGEM_RESULT_ROOT is not a readable directory: ${config.resultRoot}`,
          'Create or point to the HeyGem/Duix result directory before running the real smoke.',
        ])
      }
      const avatarAssetPath = env.DUIX_AVATAR_INTEGRATION_AVATAR_ASSET?.trim() || env.HEYGEM_INTEGRATION_AVATAR_ASSET?.trim()
      if (!avatarAssetPath) {
        return fail(logger, 'missing_avatar_asset', [
          'DUIX_AVATAR_INTEGRATION_AVATAR_ASSET/HEYGEM_INTEGRATION_AVATAR_ASSET is required when DUIX_AVATAR_API_DIALECT=duix_face2face.',
          'Set it to a readable MP4/MOV/AVI/MKV/WebM face video so the adapter does not submit a library id-only avatar to Duix.',
        ])
      }
      const avatarAssetCheck = checkReadableFile(avatarAssetPath, 'DUIX_AVATAR_INTEGRATION_AVATAR_ASSET/HEYGEM_INTEGRATION_AVATAR_ASSET')
      if (avatarAssetCheck) return fail(logger, avatarAssetCheck.reason, avatarAssetCheck.messages)
      const avatarExtension = path.extname(avatarAssetPath).toLowerCase()
      if (!['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(avatarExtension)) {
        return fail(logger, 'invalid_avatar_video', [
          `DUIX_AVATAR_INTEGRATION_AVATAR_ASSET must be a video file for duix_face2face mode: ${avatarAssetPath}`,
          'Use MP4/MOV/AVI/MKV/WebM face video input.',
        ])
      }
      const avatarDuration = probeAvatarDuration({
        audioPath: avatarAssetPath,
        ffprobePath: config.ffprobePath,
      })
      if (!Number.isFinite(avatarDuration) || avatarDuration <= 0) {
        return fail(logger, 'avatar_duration_probe_failed', [
          `Unable to read a positive video duration from DUIX_AVATAR_INTEGRATION_AVATAR_ASSET: ${avatarAssetPath}`,
          'Use a valid face video that ffprobe can inspect before running the real Duix smoke.',
        ])
      }
      if (!config.publicAssetBaseUrl && config.hostDataRoot && config.audioPath) {
        const audioMountCheck = checkInsideDirectory(config.audioPath, config.hostDataRoot, 'DUIX_AVATAR_INTEGRATION_AUDIO/HEYGEM_INTEGRATION_AUDIO')
        if (audioMountCheck) return fail(logger, audioMountCheck.reason, audioMountCheck.messages)
        const avatarMountCheck = checkInsideDirectory(avatarAssetPath, config.hostDataRoot, 'DUIX_AVATAR_INTEGRATION_AVATAR_ASSET/HEYGEM_INTEGRATION_AVATAR_ASSET')
        if (avatarMountCheck) return fail(logger, avatarMountCheck.reason, avatarMountCheck.messages)
      }
    }
  }

  if (config.scriptPath) {
    const scriptCheck = checkReadableFile(config.scriptPath, 'HEYGEM_SCRIPT_PATH')
    if (scriptCheck) return fail(logger, 'missing_script_path', scriptCheck.messages)
    if (!commandExists('powershell')) {
      return fail(logger, 'powershell_missing', [
        'powershell was not found on PATH.',
        'Install PowerShell or use HEYGEM_API_URL instead of HEYGEM_SCRIPT_PATH.',
      ])
    }
  }

  if (!config.audioPath) {
    return fail(logger, 'missing_audio', [
      'DUIX_AVATAR_INTEGRATION_AUDIO/HEYGEM_INTEGRATION_AUDIO is required when RUN_HEYGEM_INTEGRATION=1.',
      'Set it to a readable audio artifact generated by IndexTTS2 or another valid voice source.',
    ])
  }
  const audioCheck = checkReadableFile(config.audioPath, 'HEYGEM_INTEGRATION_AUDIO')
  if (audioCheck) return fail(logger, audioCheck.reason, audioCheck.messages)

  const ffprobeCheck = checkCommandOrFile(config.ffprobePath, 'ffprobe', commandExists)
  if (ffprobeCheck) return fail(logger, ffprobeCheck.reason, ffprobeCheck.messages)

  const audioDuration = probeAudioDuration({
    audioPath: config.audioPath,
    ffprobePath: config.ffprobePath,
  })
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    return fail(logger, 'audio_duration_probe_failed', [
      `Unable to read a positive duration from HEYGEM_INTEGRATION_AUDIO: ${config.audioPath}`,
      'Use an audio artifact that ffprobe can inspect before running the real HeyGem smoke.',
    ])
  }

  logger.log(`HeyGem runtime preflight passed: ${normalizedApiUrl ?? config.scriptPath}`)
  return {
    status: 'ok',
    apiUrl: normalizedApiUrl,
    apiDialect: config.apiUrl ? config.apiDialect : undefined,
    resultRoot: config.resultRoot,
    scriptPath: config.scriptPath,
    audioPath: config.audioPath,
    audioDurationSeconds: audioDuration,
  }
}

function normalizeApiUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (isPlaceholderValue(url.hostname)) return undefined
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function isPlaceholderValue(value) {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return false
  return [
    'replace-with-real-key',
    'replace-with-real-token',
    'your-api-key',
    'your-key',
    'your-token',
    'your-public-app-origin',
    'changeme',
    'change-me',
    'placeholder',
    'dummy',
    'example',
  ].some((marker) => normalized === marker || normalized.includes(marker) || normalized.startsWith('your-')) ||
    normalized.startsWith('replace-with-')
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
        'Use a non-empty file.',
      ],
    }
  }
  return undefined
}

function checkInsideDirectory(filePath, rootPath, label) {
  const relative = path.relative(rootPath, filePath)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return undefined
  return {
    reason: 'asset_not_mounted',
    messages: [
      `${label} must be inside DUIX_AVATAR_HOST_DATA_ROOT/HEYGEM_HOST_DATA_ROOT when no public asset base URL is configured.`,
      'Move the smoke asset under the Duix host data root or set DUIX_AVATAR_PUBLIC_ASSET_BASE_URL.',
    ],
  }
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
      `Install ${label} or set FFPROBE_PATH to an executable path.`,
    ],
  }
}

function defaultCommandExists(command) {
  const result = spawnSync(command, ['-version'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error
}

function defaultCheckApiReachable(value, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(value)
    const isHttps = url.protocol === 'https:'
    const port = Number(url.port || (isHttps ? 443 : 80))
    const options = {
      host: url.hostname,
      port,
      servername: url.hostname,
      timeout: timeoutMs,
    }
    const socket = isHttps
      ? tls.connect(options, () => {
          socket.end()
          resolve(true)
        })
      : net.connect(options, () => {
          socket.end()
          resolve(true)
        })

    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

async function defaultCheckDuixFace2FaceEndpoint(baseUrl, { apiKey, timeoutMs }) {
  try {
    const response = await fetch(`${baseUrl}/easy/query?code=__koubo_preflight__`, {
      method: 'GET',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 404 || response.status === 405) {
      return {
        ok: false,
        reason: 'duix_endpoint_missing',
        messages: [
          `Duix face2face endpoint is not available at ${baseUrl}/easy/query.`,
          'Point DUIX_AVATAR_API_URL to the Duix-Avatar service that exposes /easy/submit and /easy/query.',
        ],
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: 'duix_endpoint_unreachable',
      messages: [
        `Unable to probe Duix face2face endpoint at ${baseUrl}/easy/query.`,
        error instanceof Error ? error.message : String(error),
      ],
    }
  }
}

function probeDurationWithFfprobe({ audioPath, ffprobePath }) {
  const result = spawnSync(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    audioPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return Number.NaN
  return Number.parseFloat(String(result.stdout).trim())
}

function fail(logger, reason, messages) {
  for (const message of messages) {
    logger.error(message)
  }
  return { status: 'failed', reason }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await runHeyGemSmokePreflight()
  process.exit(result.status === 'failed' ? 1 : 0)
}
