import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FEATURE_TYPES, getFeatureConfig, isFeatureType } from './feature-registry'

describe('feature registry', () => {
  it('resolves digital-human resources from the generic agent resource root', () => {
    const config = getFeatureConfig('digital-human')
    const expectedRoot = path.join(process.cwd(), 'agent-resources', 'features', 'digital-human')

    expect(FEATURE_TYPES).toEqual(['digital-human'])
    expect(config.rootDir).toBe(expectedRoot)
    expect(config.systemPromptPath).toBe(path.join(expectedRoot, 'SYSTEM.md'))
    expect(config.promptsDir).toBe(path.join(expectedRoot, 'prompts'))
    expect(Object.values(config).join(' ')).not.toContain('.pi-app')
  })

  it('ships every configured resource and limits platform guidance to Douyin and Xiaohongshu', () => {
    const config = getFeatureConfig('digital-human')
    const promptPath = path.join(config.promptsDir, `${config.defaultPrompt}.md`)
    const combined = [config.systemPromptPath, promptPath]
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n')

    expect(fs.existsSync(config.systemPromptPath)).toBe(true)
    expect(fs.existsSync(promptPath)).toBe(true)
    expect(combined).toContain('抖音')
    expect(combined).toContain('小红书')
    expect(combined).not.toContain('视频号')
  })

  it('accepts only registered feature types', () => {
    expect(isFeatureType('digital-human')).toBe(true)
    expect(isFeatureType('unknown')).toBe(false)
    expect(isFeatureType(undefined)).toBe(false)
  })
})
