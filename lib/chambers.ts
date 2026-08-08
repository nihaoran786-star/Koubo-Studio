export type ChamberId =
  | 'idea'
  | 'voice'
  | 'avatar'
  | 'render'
  | 'publish'

export interface Chamber {
  id: ChamberId
  index: number
  code: string
  label: string
  zh: string
}

export const CHAMBERS: Chamber[] = [
  { id: 'idea', index: 0, code: 'Idea', label: 'Idea', zh: '文案' },
  { id: 'voice', index: 1, code: 'Voice', label: 'Voice', zh: '声音' },
  { id: 'avatar', index: 2, code: 'Avatar', label: 'Avatar', zh: '数字人' },
  { id: 'render', index: 3, code: 'Render', label: 'Render', zh: '成片' },
  { id: 'publish', index: 4, code: 'Publish', label: 'Publish', zh: '发布' },
]
