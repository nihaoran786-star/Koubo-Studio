import { describe, expect, it } from 'vitest'
import { detectRuntimeReadiness } from './runtime-readiness-service'

describe('runtime readiness', () => {
  it('does not require an external publish backend for the publish profile', () => {
    const result = detectRuntimeReadiness({
      env: {
        KOUBO_RUNTIME_PROFILE: 'publish_enhanced',
        RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE: '1',
      },
      providerState: 'connected',
      commandExists: () => true,
    })

    expect(result.profile.requiredCheckIds).toEqual(['model_provider', 'post_production', 'browser_publish'])
    expect(result.checks.map((check) => check.id)).toContain('browser_publish')
    expect(result.checks.find((check) => check.id === 'browser_publish')).toMatchObject({
      status: 'warning',
      requiredForCurrentProfile: true,
      remediation: { envKeys: [] },
    })
  })

  it('keeps heavy generation runtimes optional for the base profile', () => {
    const result = detectRuntimeReadiness({ env: {}, commandExists: () => false })
    expect(result.profile.id).toBe('base')
    expect(result.checks.find((check) => check.id === 'indextts2')).toMatchObject({
      status: 'warning',
      optionalForCurrentProfile: true,
    })
  })

  it('accepts a configured Provider from the application settings store', () => {
    const result = detectRuntimeReadiness({
      providerState: 'connected',
      commandExists: () => false,
    })
    expect(result.checks.find((check) => check.id === 'model_provider')).toMatchObject({
      status: 'ready',
      gaps: [],
    })
    expect(result.status).toBe('ready')
  })

  it('does not let smoke flags or an unprobed URL fake generation runtime readiness', () => {
    const result = detectRuntimeReadiness({
      env: {
        KOUBO_RUNTIME_PROFILE: 'local_enhanced',
        RUN_INDEXTTS2_INTEGRATION: '1',
        RUN_HEYGEM_INTEGRATION: '1',
        DUIX_AVATAR_API_URL: 'http://127.0.0.1:8383',
      },
      providerState: 'connected',
      commandExists: () => true,
      endpointReachable: () => false,
    })
    expect(result.checks.find((check) => check.id === 'indextts2')).toMatchObject({ status: 'missing' })
    expect(result.checks.find((check) => check.id === 'heygem')).toMatchObject({
      status: 'missing',
      gaps: ['Duix/HeyGem API 协议探测失败。'],
    })
  })

  it('reports a probed Duix endpoint as ready', () => {
    const url = 'http://127.0.0.1:8383'
    const result = detectRuntimeReadiness({
      env: { KOUBO_RUNTIME_PROFILE: 'local_enhanced', DUIX_AVATAR_API_URL: url },
      providerState: 'connected',
      commandExists: () => true,
      endpointReachable: (value) => value === url,
    })
    expect(result.checks.find((check) => check.id === 'heygem')).toMatchObject({ status: 'ready', gaps: [] })
  })

  it('reports HeyGem ready only for a healthy managed runtime', () => {
    const ready = detectRuntimeReadiness({
      env: { KOUBO_RUNTIME_PROFILE: 'local_enhanced' },
      providerState: 'connected',
      managedRuntimeStatus: 'ready',
      commandExists: () => true,
    })
    expect(ready.checks.find((check) => check.id === 'heygem')).toMatchObject({
      status: 'ready',
      gaps: [],
    })

    for (const status of ['absent', 'stopped', 'running', 'failed'] as const) {
      const unavailable = detectRuntimeReadiness({
        env: { KOUBO_RUNTIME_PROFILE: 'local_enhanced' },
        providerState: 'connected',
        managedRuntimeStatus: status,
        commandExists: () => true,
      })
      expect(unavailable.checks.find((check) => check.id === 'heygem')).toMatchObject({
        status: 'missing',
      })
    }
  })
})
