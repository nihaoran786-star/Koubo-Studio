import { describe, expect, it } from 'vitest'
import { inferPublishPlatformsFromText } from './publish-platform-selection'

describe('publish platform selection', () => {
  it('recognizes only douyin and xiaohongshu aliases', () => {
    expect(inferPublishPlatformsFromText({
      text: '发抖音和小红书',
      currentPlatforms: ['douyin'],
    })).toEqual({ matched: true, platforms: ['douyin', 'xiaohongshu'] })
  })

  it('keeps selection when no supported platform is mentioned', () => {
    expect(inferPublishPlatformsFromText({
      text: '帮我优化标题',
      currentPlatforms: ['xiaohongshu'],
    })).toEqual({ matched: false, platforms: ['xiaohongshu'] })
  })
})

