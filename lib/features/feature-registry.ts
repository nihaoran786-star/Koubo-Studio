import path from 'node:path'

export const FEATURE_TYPES = ['digital-human'] as const

export type FeatureType = (typeof FEATURE_TYPES)[number]

export interface FeatureConfig {
  type: FeatureType
  label: string
  rootDir: string
  systemPromptPath: string
  promptsDir: string
  defaultPrompt: string
}

const FEATURE_ROOT = path.join(process.cwd(), 'agent-resources', 'features')

const FEATURE_CONFIGS: Record<FeatureType, FeatureConfig> = {
  'digital-human': {
    type: 'digital-human',
    label: '数字人视频',
    rootDir: path.join(FEATURE_ROOT, 'digital-human'),
    systemPromptPath: path.join(FEATURE_ROOT, 'digital-human', 'SYSTEM.md'),
    promptsDir: path.join(FEATURE_ROOT, 'digital-human', 'prompts'),
    defaultPrompt: 'script',
  },
}

export function isFeatureType(value: unknown): value is FeatureType {
  return typeof value === 'string' && FEATURE_TYPES.includes(value as FeatureType)
}

export function getFeatureConfig(featureType: FeatureType): FeatureConfig {
  return FEATURE_CONFIGS[featureType]
}
