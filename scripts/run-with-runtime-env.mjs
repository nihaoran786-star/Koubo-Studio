import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadRuntimeEnvFiles } from './runtime-env.mjs'

export function runWithRuntimeEnv({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const { envOverrides, commandArgv } = parseArgs(argv)
  if (commandArgv.length === 0) {
    return {
      status: 'failed',
      exitCode: 1,
      error: 'Missing command. Usage: node scripts/run-with-runtime-env.mjs [--env KEY=VALUE] <command> [...args]',
    }
  }

  const { env: mergedEnv } = loadRuntimeEnvFiles({ cwd, env })
  const [command, ...args] = commandArgv
  const result = spawn(command, args, {
    cwd,
    env: {
      ...mergedEnv,
      ...envOverrides,
    },
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  })

  return {
    status: result.status === 0 ? 'ok' : 'failed',
    exitCode: typeof result.status === 'number' ? result.status : 1,
    error: result.error?.message,
  }
}

function parseArgs(argv) {
  const envOverrides = {}
  const commandArgv = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--env') {
      const pair = argv[index + 1]
      index += 1
      applyEnvPair(envOverrides, pair)
      continue
    }
    if (arg?.startsWith('--env=')) {
      applyEnvPair(envOverrides, arg.slice('--env='.length))
      continue
    }
    commandArgv.push(arg, ...argv.slice(index + 1))
    break
  }
  return { envOverrides, commandArgv }
}

function applyEnvPair(target, pair) {
  const index = pair?.indexOf('=')
  if (!pair || index <= 0) return
  target[pair.slice(0, index)] = pair.slice(index + 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runWithRuntimeEnv()
  if (result.error) console.error(result.error)
  process.exit(result.exitCode)
}
