import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'

const PLATFORM_ALIASES: Record<PublishPlatformId, string[]> = {
  douyin: ['抖音', 'douyin'],
  xiaohongshu: ['小红书', 'xiaohongshu', 'xhs', 'rednote', 'red note'],
}

export function inferPublishPlatformsFromText(input: {
  text: string
  currentPlatforms: PublishPlatformId[]
}): { matched: boolean; platforms: PublishPlatformId[] } {
  const normalized = input.text.trim().toLowerCase().replace(/[#/，。；、]/g, ' ').replace(/\s+/g, ' ')
  if (!normalized) return { matched: false, platforms: input.currentPlatforms }

  const allRequested = ['两个平台', '全部平台', '所有平台', 'all platforms'].some((text) => normalized.includes(text))
  if (allRequested) return { matched: true, platforms: ['douyin', 'xiaohongshu'] }

  const matches = (Object.keys(PLATFORM_ALIASES) as PublishPlatformId[]).filter((platformId) =>
    PLATFORM_ALIASES[platformId].some((alias) => normalized.includes(alias)),
  )
  return matches.length > 0
    ? { matched: true, platforms: matches }
    : { matched: false, platforms: input.currentPlatforms }
}
