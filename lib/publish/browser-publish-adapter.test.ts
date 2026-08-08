import { describe, expect, it } from 'vitest'
import { getBrowserPublishReadiness, prepareBrowserPublishTargets } from './browser-publish-adapter'

describe('browser publish adapter seam', () => {
  it('reports manual supervision without claiming publish success', () => {
    expect(getBrowserPublishReadiness()).toEqual({
      status: 'manual_required',
      source: 'visible_browser',
      supportedPlatforms: ['douyin', 'xiaohongshu'],
      message: '已支持自动打开平台发布页并填写草稿；登录、风控和最终提交必须由用户监督并确认。',
    })
  })

  it('prepares official publish targets for douyin and xiaohongshu', () => {
    const targets = prepareBrowserPublishTargets({
      platforms: ['douyin', 'xiaohongshu'],
      title: '标题',
      description: '正文',
      tags: ['#口播'],
    })
    expect(targets).toEqual([
      expect.objectContaining({ platformId: 'douyin', browserStatus: 'manual_required' }),
      expect.objectContaining({ platformId: 'xiaohongshu', browserStatus: 'manual_required' }),
    ])
  })
})
