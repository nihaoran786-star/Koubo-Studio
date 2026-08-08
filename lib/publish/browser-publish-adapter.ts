import type { PublishPlatformId, PublishPlatformPackage } from '@/lib/artifacts/publish-package-artifact'

const PUBLISH_PAGES: Record<PublishPlatformId, string> = {
  douyin: 'https://creator.douyin.com/creator-micro/content/upload',
  xiaohongshu: 'https://creator.xiaohongshu.com/publish/publish',
}

export interface BrowserPublishReadiness {
  status: 'manual_required'
  source: 'visible_browser'
  supportedPlatforms: PublishPlatformId[]
  message: string
}

export function getBrowserPublishReadiness(): BrowserPublishReadiness {
  return {
    status: 'manual_required',
    source: 'visible_browser',
    supportedPlatforms: ['douyin', 'xiaohongshu'],
    message: '已支持自动打开平台发布页并填写草稿；登录、风控和最终提交必须由用户监督并确认。',
  }
}

export function prepareBrowserPublishTargets(input: {
  platforms: PublishPlatformId[]
  title: string
  description: string
  tags: string[]
}): PublishPlatformPackage[] {
  return input.platforms.map((platformId) => ({
    platformId,
    platformName: platformId === 'douyin' ? '抖音' : '小红书',
    browserStatus: 'manual_required',
    publishPageUrl: PUBLISH_PAGES[platformId],
    title: input.title,
    description: input.description,
    tags: input.tags,
  }))
}
