import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'

export type BrowserPublishStatus =
  | 'idle'
  | 'opening'
  | 'login_required'
  | 'ready_to_fill'
  | 'filling'
  | 'awaiting_user_submit'
  | 'failed'
  | 'closed'

export interface BrowserPublishError {
  code: string
  message: string
}

export interface BrowserPublishSnapshot {
  status: BrowserPublishStatus
  source: 'visible_browser'
  platformId?: PublishPlatformId
  projectId?: string
  artifactId?: string
  pageUrl?: string
  error?: BrowserPublishError
  updatedAt: string
}

export interface BrowserPublishDraft {
  platformId: PublishPlatformId
  publishPageUrl: string
  title: string
  description: string
  tags: string[]
  videoPath: string
  coverPath?: string
}

export interface BrowserLocator {
  count(): Promise<number>
  first(): BrowserLocator
  isVisible(): Promise<boolean>
  fill(value: string): Promise<void>
  setInputFiles(files: string | string[]): Promise<void>
  inputValue?(): Promise<string>
  textContent?(): Promise<string | null>
  innerText?(): Promise<string>
}

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>
  url(): string
  locator(selector: string): BrowserLocator
  waitForTimeout?(timeout: number): Promise<void>
}

export interface BrowserSession {
  page: BrowserPage
  close(): Promise<void>
  onClosed?(listener: () => void): () => void
}

export interface BrowserRuntime {
  openPersistentContext(input: {
    executablePath: string
    profilePath: string
  }): Promise<BrowserSession>
}

export type BrowserPageReadiness = 'login_required' | 'ready_to_fill'

export interface BrowserPublishAdapter {
  readonly platformId: PublishPlatformId
  readonly publishPageUrl: string
  open(page: BrowserPage): Promise<void>
  inspect(page: BrowserPage): Promise<BrowserPageReadiness>
  fillDraft(page: BrowserPage, draft: BrowserPublishDraft): Promise<void>
}

export interface BrowserPublishTarget {
  projectId: string
  artifactId: string
  platformId: PublishPlatformId
}
