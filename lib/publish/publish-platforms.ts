import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'

export interface PublishPlatformDefinition {
  id: PublishPlatformId
  name: string
  accent: string
  hint: string
}

export const PUBLISH_PLATFORMS: PublishPlatformDefinition[] = [
  {
    id: 'douyin',
    name: '抖音',
    accent: '#161823',
    hint: '准备视频、标题、正文和标签，浏览器步骤需用户监督。',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    accent: '#ff2442',
    hint: '准备视频、封面、正文和标签，浏览器步骤需用户监督。',
  },
]

export const PUBLISH_PLATFORM_NAMES: Record<PublishPlatformId, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
}

