import { describe, expect, it } from 'vitest'
import { buildRuntimeReadinessNotice } from './runtime-readiness-notice'
import type { RuntimeReadinessApiResult } from './runtime-readiness-types'

describe('buildRuntimeReadinessNotice', () => {
  it('returns no notice before readiness is loaded', () => {
    expect(buildRuntimeReadinessNotice(undefined, 'voice')).toBeUndefined()
  })

  it('maps the current chamber to its runtime check', () => {
    expect(buildRuntimeReadinessNotice(readinessFixture, 'voice')).toEqual({
      id: 'runtime_readiness_indextts2',
      title: 'IndexTTS2 运行环境未就绪',
      message: '缺少 RUN_INDEXTTS2_INTEGRATION=1',
      action: '配置 IndexTTS2。',
      actionLabel: '打开设置',
      tone: 'error',
    })
  })

  it('does not warn when the mapped check is ready', () => {
    expect(buildRuntimeReadinessNotice(readinessFixture, 'idea')).toBeUndefined()
  })
})

const readinessFixture: RuntimeReadinessApiResult = {
  status: 'missing',
  source: 'runtime_readiness',
  profile: {
    id: 'full',
    title: '完整验收',
    description: '要求所有 runtime 前置条件齐备。',
    requiredCheckIds: ['model_provider', 'indextts2'],
  },
  updatedAt: '2026-06-11T00:00:00.000Z',
  summary: {
    ready: 1,
    missing: 1,
    warning: 0,
  },
  checks: [
    {
      id: 'model_provider',
      title: 'AI 文案 Provider',
      status: 'ready',
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: [],
      nextStep: '运行 smoke。',
      provisioning: {
        priority: 1,
        stage: '文本智能体 Provider',
        required: ['OpenAI-compatible API endpoint'],
        sensitiveEnvKeys: ['OPENAI_API_KEY'],
        safeEvidence: '只保留脱敏状态。',
      },
      remediation: {
        envKeys: [],
        envTemplate: '# 设置页配置',
        command: 'pnpm smoke:model-provider',
        docPath: 'docs/RUNTIME_PROVISIONING.md#推荐顺序',
      },
    },
    {
      id: 'indextts2',
      title: 'IndexTTS2',
      status: 'missing',
      requiredForCurrentProfile: true,
      optionalForCurrentProfile: false,
      gaps: ['缺少 RUN_INDEXTTS2_INTEGRATION=1'],
      nextStep: '配置 IndexTTS2。',
      provisioning: {
        priority: 2,
        stage: '声音克隆与音频生成',
        required: ['IndexTTS2 runtime root'],
        sensitiveEnvKeys: [],
        safeEvidence: '只保留音频 artifact。',
      },
      remediation: {
        envKeys: ['RUN_INDEXTTS2_INTEGRATION'],
        envTemplate: 'RUN_INDEXTTS2_INTEGRATION=1',
        command: 'pnpm smoke:indextts2',
        docPath: 'docs/SMOKE_TESTS.md#indextts2',
      },
    },
  ],
}
