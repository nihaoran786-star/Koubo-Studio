import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const template = readFileSync('.env.runtime.example', 'utf8')

const requiredKeys = [
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'RUN_MODEL_PROVIDER_SMOKE',
  'MODEL_PROVIDER_SMOKE_BACKEND_URL',
  'MODEL_PROVIDER_SMOKE_PROVIDER_ID',
  'MODEL_PROVIDER_SMOKE_BASE_URL',
  'MODEL_PROVIDER_SMOKE_MODEL',
  'MODEL_PROVIDER_SMOKE_API_KEY',
  'RUN_INDEXTTS2_INTEGRATION',
  'INDEXTTS2_RUNTIME_ROOT',
  'INDEXTTS2_REFERENCE_AUDIO',
  'INDEXTTS2_SCRIPT_PATH',
  'INDEXTTS2_TIMEOUT_MS',
  'RUN_HEYGEM_INTEGRATION',
  'HEYGEM_API_URL',
  'HEYGEM_API_KEY',
  'HEYGEM_SCRIPT_PATH',
  'HEYGEM_INTEGRATION_AUDIO',
  'HEYGEM_INTEGRATION_AVATAR_ID',
  'HEYGEM_TIMEOUT_MS',
  'RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE',
  'POST_PRODUCTION_SKILL_SCRIPT_PATH',
  'POST_PRODUCTION_SMOKE_OUTPUT_ROOT',
  'NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL',
  'RUN_DESKTOP_BACKEND_SMOKE',
  'DESKTOP_LOCAL_BACKEND_URL',
  'RUN_DESKTOP_RELEASE_SMOKE',
  'DESKTOP_RELEASE_EXE_PATH',
  'DESKTOP_BACKEND_NODE_PATH',
]

describe('runtime env template', () => {
  it('documents every runtime smoke variable used by provisioning', () => {
    for (const key of requiredKeys) {
      expect(template).toContain(`${key}=`)
    }
  })

  it('keeps real secrets out of the committed template', () => {
    expect(template).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(template).not.toContain('cookie=')
    expect(template).not.toContain('session=')
  })

  it('does not document the retired external publishing system', () => {
    expect(template.toUpperCase()).not.toContain(['AITO', 'EARN'].join(''))
  })
})
