export const REMOTION_EFFECT_IDS = [
  'animated-captions',
  'hook-card',
  'punch-zoom',
  'progress-line',
  'light-leak',
  'film-burn',
  'focus-glow',
] as const

export type RemotionEffectId = (typeof REMOTION_EFFECT_IDS)[number]

export interface RemotionEffectDefinition {
  id: RemotionEffectId
  label: string
  category: 'captions' | 'motion' | 'overlay' | 'transition'
  compute: 'low' | 'medium' | 'high'
  description: string
}

export const REMOTION_EFFECT_REGISTRY: readonly RemotionEffectDefinition[] = [
  {
    id: 'animated-captions',
    label: '逐词动态字幕',
    category: 'captions',
    compute: 'low',
    description: '字幕按短句进入，当前重点词使用强调色和轻微弹入。',
  },
  {
    id: 'hook-card',
    label: '开场钩子卡',
    category: 'overlay',
    compute: 'low',
    description: '开头显示一张短标题卡，快速建立本条视频的核心看点。',
  },
  {
    id: 'punch-zoom',
    label: '节奏推镜',
    category: 'motion',
    compute: 'medium',
    description: '在重点语句和节拍点做克制的推近与复位。',
  },
  {
    id: 'progress-line',
    label: '观看进度线',
    category: 'overlay',
    compute: 'low',
    description: '底部显示细进度线，增强短视频的完成感。',
  },
  {
    id: 'light-leak',
    label: '漏光叠化',
    category: 'transition',
    compute: 'medium',
    description: '在段落切换处使用短暂暖色漏光覆盖。',
  },
  {
    id: 'film-burn',
    label: '胶片灼烧',
    category: 'transition',
    compute: 'high',
    description: '在强转折处使用短促胶片灼烧，不连续滥用。',
  },
  {
    id: 'focus-glow',
    label: '重点辉光',
    category: 'overlay',
    compute: 'medium',
    description: '重点词出现时增加局部柔和辉光和暗角。',
  },
] as const

export function isRemotionEffectId(value: unknown): value is RemotionEffectId {
  return typeof value === 'string' && (REMOTION_EFFECT_IDS as readonly string[]).includes(value)
}
