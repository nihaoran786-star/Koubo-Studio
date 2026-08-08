export type ProjectStatus = 'draft' | 'editing' | 'pending' | 'published'

export interface Project {
  id: string
  title: string
  cover: string
  /** 作品卡只渲染由 workspace 已验证关联的媒体，不从页面猜测产物来源。 */
  coverMediaType?: 'image' | 'video'
  status: ProjectStatus
  duration: string
  updatedAt: string
  platforms: string[]
  step?: number // for in-progress, which step (1-5)
  furthestStep?: number
  views?: number
  likes?: number
  newFans?: number
}

export const STATUS_META: Record<
  ProjectStatus,
  { zh: string; tone: 'idle' | 'cyan' | 'warning' | 'success' }
> = {
  draft: { zh: '草稿', tone: 'idle' },
  editing: { zh: '制作中', tone: 'cyan' },
  pending: { zh: '待发布', tone: 'warning' },
  published: { zh: '已发布', tone: 'success' },
}
