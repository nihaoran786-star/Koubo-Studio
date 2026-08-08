import {
  assertOfficialPublishPage,
  combineDescription,
  fillAndVerify,
  uploadAndVerify,
  waitForPageReadiness,
} from '../adapter-helpers'
import { PUBLISH_SELECTORS } from '../selectors'
import type { BrowserPublishAdapter } from '../types'

export const douyinBrowserPublishAdapter: BrowserPublishAdapter = {
  platformId: 'douyin',
  publishPageUrl: 'https://creator.douyin.com/creator-micro/content/upload',

  async open(page) {
    await page.goto(this.publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  },

  async inspect(page) {
    return waitForPageReadiness(page, PUBLISH_SELECTORS.douyin.authenticated, PUBLISH_SELECTORS.douyin.login)
  },

  async fillDraft(page, draft) {
    assertOfficialPublishPage(page, this.publishPageUrl)
    await uploadAndVerify(page, PUBLISH_SELECTORS.douyin.video, '视频上传入口', draft.videoPath)
    await fillAndVerify(page, PUBLISH_SELECTORS.douyin.title, '作品标题输入框', draft.title)
    await fillAndVerify(
      page,
      PUBLISH_SELECTORS.douyin.description,
      '作品描述输入框',
      combineDescription(draft.description, draft.tags),
    )
    assertOfficialPublishPage(page, this.publishPageUrl)
  },
}
