import {
  assertOfficialPublishPage,
  combineDescription,
  fillAndVerify,
  uploadAndVerify,
  waitForPageReadiness,
} from '../adapter-helpers'
import { PUBLISH_SELECTORS } from '../selectors'
import type { BrowserPublishAdapter } from '../types'

export const xiaohongshuBrowserPublishAdapter: BrowserPublishAdapter = {
  platformId: 'xiaohongshu',
  publishPageUrl: 'https://creator.xiaohongshu.com/publish/publish',

  async open(page) {
    await page.goto(this.publishPageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  },

  async inspect(page) {
    return waitForPageReadiness(page, PUBLISH_SELECTORS.xiaohongshu.authenticated, PUBLISH_SELECTORS.xiaohongshu.login)
  },

  async fillDraft(page, draft) {
    assertOfficialPublishPage(page, this.publishPageUrl)
    await uploadAndVerify(page, PUBLISH_SELECTORS.xiaohongshu.video, '视频上传入口', draft.videoPath)
    await fillAndVerify(page, PUBLISH_SELECTORS.xiaohongshu.title, '标题输入框', draft.title)
    await fillAndVerify(
      page,
      PUBLISH_SELECTORS.xiaohongshu.description,
      '正文输入框',
      combineDescription(draft.description, draft.tags),
    )
    assertOfficialPublishPage(page, this.publishPageUrl)
  },
}
