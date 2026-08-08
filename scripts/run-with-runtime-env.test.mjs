import { describe, expect, it } from 'vitest'
import { runWithRuntimeEnv } from './run-with-runtime-env.mjs'

describe('run-with-runtime-env', () => {
  it('passes explicit env overrides to the child command', () => {
    let captured
    const result = runWithRuntimeEnv({
      argv: ['--env', 'RUN_HEYGEM_LOCAL_API_SMOKE=1', 'vitest', 'run', 'target.test.ts'],
      env: {},
      spawn: (command, args, options) => {
        captured = { command, args, env: options.env }
        return { status: 0 }
      },
    })

    expect(result.status).toBe('ok')
    expect(captured.command).toBe('vitest')
    expect(captured.args).toEqual(['run', 'target.test.ts'])
    expect(captured.env.RUN_HEYGEM_LOCAL_API_SMOKE).toBe('1')
  })

  it('returns a command usage failure when no command is provided', () => {
    const result = runWithRuntimeEnv({
      argv: ['--env', 'RUN_HEYGEM_LOCAL_API_SMOKE=1'],
      env: {},
      spawn: () => ({ status: 0 }),
    })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
  })
})
