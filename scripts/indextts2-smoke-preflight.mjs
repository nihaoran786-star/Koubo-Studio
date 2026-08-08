import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function readIndexTTS2SmokeConfig(env = process.env, cwd = process.cwd()) {
  const runtimeRoot = env.INDEXTTS2_RUNTIME_ROOT?.trim()
  const scriptPath = env.INDEXTTS2_SCRIPT_PATH?.trim() ||
    path.resolve(cwd, '..', 'skills', 'natural-tts-voice-cloning', 'scripts', 'Invoke-NaturalTTS.ps1')
  return {
    enabled: env.RUN_INDEXTTS2_INTEGRATION === '1',
    runtimeRoot,
    referenceAudioPath: env.INDEXTTS2_REFERENCE_AUDIO?.trim(),
    scriptPath,
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH?.trim() || 'ffprobe',
  }
}

export async function runIndexTTS2SmokePreflight({
  env = process.env,
  cwd = process.cwd(),
  logger = console,
  commandExists = defaultCommandExists,
  probeAudioDuration = probeDurationWithFfprobe,
} = {}) {
  const config = readIndexTTS2SmokeConfig(env, cwd)
  if (!config.enabled) {
    logger.log('IndexTTS2 smoke skipped. Set RUN_INDEXTTS2_INTEGRATION=1 and INDEXTTS2_REFERENCE_AUDIO to check a real runtime.')
    return { status: 'skipped', reason: 'disabled' }
  }

  if (!config.referenceAudioPath) {
    return fail(logger, 'missing_reference_audio', [
      'INDEXTTS2_REFERENCE_AUDIO is required when RUN_INDEXTTS2_INTEGRATION=1.',
      'Set it to a readable WAV/MP3/M4A reference voice sample.',
    ])
  }
  if (isTemplateValue(config.referenceAudioPath)) {
    return fail(logger, 'placeholder_reference_audio', [
      `INDEXTTS2_REFERENCE_AUDIO is still a template path: ${config.referenceAudioPath}`,
      'Set it to a real 8-12 second WAV/MP3/M4A reference voice sample.',
    ])
  }
  const referenceCheck = checkReadableFile(config.referenceAudioPath, 'INDEXTTS2_REFERENCE_AUDIO')
  if (referenceCheck) return fail(logger, referenceCheck.reason, referenceCheck.messages)

  if (!config.runtimeRoot) {
    return fail(logger, 'missing_runtime_root', [
      'INDEXTTS2_RUNTIME_ROOT is required when RUN_INDEXTTS2_INTEGRATION=1.',
      'Expected layout: <runtime root>\\IndexTTS\\.venv\\Scripts\\python.exe and <runtime root>\\IndexTTS\\checkpoints\\config.yaml',
    ])
  }
  if (isTemplateValue(config.runtimeRoot)) {
    return fail(logger, 'placeholder_runtime_root', [
      `INDEXTTS2_RUNTIME_ROOT is still a template path: ${config.runtimeRoot}`,
      'Set it to the real parent directory that contains the IndexTTS runtime folder.',
    ])
  }
  if (!fs.existsSync(config.runtimeRoot) || !fs.statSync(config.runtimeRoot).isDirectory()) {
    return fail(logger, 'invalid_runtime_root', [
      `INDEXTTS2_RUNTIME_ROOT is not a readable directory: ${config.runtimeRoot}`,
      'Point it to the parent directory that contains the IndexTTS folder.',
    ])
  }

  const indexRoot = path.join(config.runtimeRoot, 'IndexTTS')
  if (!fs.existsSync(indexRoot) || !fs.statSync(indexRoot).isDirectory()) {
    return fail(logger, 'missing_index_root', [
      `IndexTTS runtime directory was not found: ${indexRoot}`,
      'Expected INDEXTTS2_RUNTIME_ROOT to contain an IndexTTS directory.',
    ])
  }

  const pythonPath = path.join(indexRoot, '.venv', 'Scripts', 'python.exe')
  const pythonCheck = checkReadableFile(pythonPath, 'IndexTTS Python runtime')
  if (pythonCheck) {
    return fail(logger, 'missing_python_runtime', [
      `IndexTTS Python runtime was not found: ${pythonPath}`,
      'Create or restore the runtime virtualenv before running the smoke.',
    ])
  }

  if (isTemplateValue(config.scriptPath)) {
    return fail(logger, 'placeholder_script_path', [
      `INDEXTTS2_SCRIPT_PATH is still a template path: ${config.scriptPath}`,
      'Set it to the real Invoke-NaturalTTS.ps1 wrapper path.',
    ])
  }
  const scriptCheck = checkReadableFile(config.scriptPath, 'INDEXTTS2_SCRIPT_PATH')
  if (scriptCheck) return fail(logger, 'missing_script_path', scriptCheck.messages)

  const wrapperCheck = checkPowerShellWrapperParameters(config.scriptPath)
  if (wrapperCheck) return fail(logger, wrapperCheck.reason, wrapperCheck.messages)

  const pythonScript = path.join(path.dirname(config.scriptPath), 'natural_tts.py')
  const pythonScriptCheck = checkReadableFile(pythonScript, 'natural_tts.py')
  if (pythonScriptCheck) {
    return fail(logger, 'missing_python_script', [
      `natural_tts.py was not found next to the PowerShell wrapper: ${pythonScript}`,
      'Restore skills/natural-tts-voice-cloning/scripts/natural_tts.py or set INDEXTTS2_SCRIPT_PATH to a matching wrapper directory.',
    ])
  }

  const checkpoints = path.join(indexRoot, 'checkpoints')
  const configPath = path.join(checkpoints, 'config.yaml')
  const configCheck = checkReadableFile(configPath, 'IndexTTS2 checkpoints config.yaml')
  if (configCheck) {
    return fail(logger, 'missing_model_config', [
      `IndexTTS2 model config was not found: ${configPath}`,
      'Place IndexTTS2 model weights under <runtime root>\\IndexTTS\\checkpoints before running the smoke.',
    ])
  }
  warnIfNoModelWeights(checkpoints, logger)

  for (const [label, command] of [['ffmpeg', config.ffmpegPath], ['ffprobe', config.ffprobePath]]) {
    const dependencyCheck = checkCommandOrFile(command, label, commandExists)
    if (dependencyCheck) return fail(logger, dependencyCheck.reason, dependencyCheck.messages)
  }

  const referenceDuration = probeAudioDuration({
    audioPath: config.referenceAudioPath,
    ffprobePath: config.ffprobePath,
  })
  if (!Number.isFinite(referenceDuration) || referenceDuration <= 0) {
    return fail(logger, 'reference_audio_duration_probe_failed', [
      `Unable to read duration from INDEXTTS2_REFERENCE_AUDIO: ${config.referenceAudioPath}`,
      'Use a readable WAV/MP3/M4A file and ensure ffprobe can inspect it.',
    ])
  }
  if (referenceDuration < 8 || referenceDuration > 12) {
    return fail(logger, 'reference_audio_duration_out_of_range', [
      `INDEXTTS2_REFERENCE_AUDIO duration is ${referenceDuration.toFixed(2)} seconds.`,
      'Use an 8-12 second reference voice sample for the real IndexTTS2 smoke.',
    ])
  }

  logger.log(`IndexTTS2 runtime preflight passed: ${indexRoot}`)
  return {
    status: 'ok',
    runtimeRoot: config.runtimeRoot,
    indexRoot,
    scriptPath: config.scriptPath,
    referenceAudioPath: config.referenceAudioPath,
    referenceDurationSeconds: referenceDuration,
  }
}

function checkReadableFile(filePath, envName) {
  if (!fs.existsSync(filePath)) {
    return {
      reason: 'missing_file',
      messages: [
        `${envName} does not exist: ${filePath}`,
        'Use an absolute path to a local file that the current process can read.',
      ],
    }
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    return {
      reason: 'invalid_file',
      messages: [
        `${envName} is not a file: ${filePath}`,
        'Use a regular local file, not a directory.',
      ],
    }
  }
  if (stat.size <= 0) {
    return {
      reason: 'empty_file',
      messages: [
        `${envName} is empty: ${filePath}`,
        'Use a non-empty file.',
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
    normalized.includes('<runtime root>') ||
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
      `Install ${label} or set ${label === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'} to an executable path.`,
    ],
  }
}

function warnIfNoModelWeights(checkpoints, logger) {
  try {
    const entries = fs.readdirSync(checkpoints)
    const hasWeight = entries.some((entry) => /\.(pth|pt|safetensors|bin)$/i.test(entry))
    if (!hasWeight) {
      logger.warn?.(`No obvious model weight file was found in ${checkpoints}. If runtime fails with model_weights_missing, restore IndexTTS2 checkpoints.`)
    }
  } catch {
    logger.warn?.(`Unable to inspect model weights in ${checkpoints}.`)
  }
}

function checkPowerShellWrapperParameters(scriptPath) {
  const requiredParameters = [
    'ReferenceAudio',
    'Text',
    'Output',
    'OutputFormat',
    'RuntimeRoot',
    'EmotionText',
    'EmotionAlpha',
    'Speed',
    'EmotionReferenceAudio',
    'Seed',
    'UseRandom',
    'TrimSeconds',
  ]
  let content = ''
  try {
    content = fs.readFileSync(scriptPath, 'utf8')
  } catch {
    return {
      reason: 'wrapper_parameter_mismatch',
      messages: [
        `Unable to inspect INDEXTTS2_SCRIPT_PATH parameters: ${scriptPath}`,
        'Ensure the PowerShell wrapper is readable before running the real smoke.',
      ],
    }
  }

  const missing = requiredParameters.filter((parameterName) => {
    const parameterPattern = new RegExp(`\\$${parameterName}\\b`, 'i')
    return !parameterPattern.test(content)
  })
  if (missing.length === 0) return undefined

  return {
    reason: 'wrapper_parameter_mismatch',
    messages: [
      `INDEXTTS2_SCRIPT_PATH is missing parameters required by the app adapter: ${missing.join(', ')}`,
      'Use skills/natural-tts-voice-cloning/scripts/Invoke-NaturalTTS.ps1 or update the wrapper to accept the app adapter contract.',
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
  const result = await runIndexTTS2SmokePreflight()
  process.exit(result.status === 'failed' ? 1 : 0)
}
