import { spawn as spawnProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesktopNodeRuntime } from './desktop-node-runtime.mjs'
import { loadRuntimeEnvFiles } from './runtime-env.mjs'

export function createDesktopDevBackendPlan({
  root = process.cwd(),
  env = process.env,
  resolveNode = resolveDesktopNodeRuntime,
} = {}) {
  const runtimeEnv = loadRuntimeEnvFiles({ cwd: root, env })
  const node = resolveNode({ root, env: runtimeEnv.env })
  if (node.status !== 'ok') return node

  return {
    status: 'ok',
    command: node.nodePath,
    args: [
      path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '--webpack',
      '--hostname', '127.0.0.1',
      '--port', '3100',
    ],
    env: runtimeEnv.env,
    loadedFiles: runtimeEnv.loadedFiles,
    nodePath: node.nodePath,
    nodeVersion: node.nodeVersion,
    nodeSource: node.source,
  }
}

export function runDesktopDevBackend({
  root = process.cwd(),
  processRef = process,
  spawn = spawnProcess,
  logger = console,
  createPlan = createDesktopDevBackendPlan,
} = {}) {
  const plan = createPlan({ root, env: processRef.env })
  if (plan.status !== 'ok') {
    logger.error(`Desktop dev backend failed (${plan.error.code}): ${plan.error.message}`)
    processRef.exitCode = 1
    return Promise.resolve(plan)
  }

  logger.log(`Desktop dev backend: Node ${plan.nodeVersion || 'unknown'} (${plan.nodeSource || 'resolved'})`)
  const child = spawn(plan.command, plan.args, {
    cwd: root,
    env: plan.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  const signals = ['SIGINT', 'SIGTERM']
  const handlers = new Map(signals.map((signal) => [signal, () => child.kill(signal)]))
  for (const [signal, handler] of handlers) processRef.on(signal, handler)

  return new Promise((resolve) => {
    child.once('error', (error) => {
      cleanup()
      processRef.exitCode = 1
      resolve({ status: 'failed', error: { code: 'desktop_dev_backend_spawn_failed', message: error.message } })
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (signal) {
        processRef.kill(processRef.pid, signal)
        resolve({ status: 'failed', signal })
        return
      }
      const exitCode = code ?? 1
      processRef.exitCode = exitCode
      resolve(exitCode === 0 ? { status: 'ok', exitCode } : { status: 'failed', exitCode })
    })
  })

  function cleanup() {
    for (const [signal, handler] of handlers) processRef.off(signal, handler)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await runDesktopDevBackend()
}
