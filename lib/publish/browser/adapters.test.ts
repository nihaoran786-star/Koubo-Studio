import { describe, expect, it } from 'vitest'
import { douyinBrowserPublishAdapter } from './adapters/douyin'
import { xiaohongshuBrowserPublishAdapter } from './adapters/xiaohongshu'
import type { BrowserLocator, BrowserPage } from './types'

describe('browser publish adapters', () => {
  it.each([
    ['douyin', douyinBrowserPublishAdapter],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter],
  ] as const)('%s 只填写视频和草稿，不具备最终提交能力', async (_name, adapter) => {
    const values: Record<string, string | string[]> = {}
    const page = createFormPage(values, { pageUrl: adapter.publishPageUrl })
    await expect(adapter.inspect(page)).resolves.toBe('ready_to_fill')
    await adapter.fillDraft(page, {
      platformId: adapter.platformId,
      publishPageUrl: adapter.publishPageUrl,
      videoPath: 'D:\\workspace\\final.mp4',
      title: '标题',
      description: '正文',
      tags: ['口播', '#数字人'],
    })
    expect(values.video).toBe('D:\\workspace\\final.mp4')
    expect(values.title).toBe('标题')
    expect(values.description).toBe('正文\n\n#口播 #数字人')
    expect('submit' in adapter).toBe(false)
  })

  it.each([
    ['douyin', douyinBrowserPublishAdapter],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter],
  ] as const)('%s 不会把登录页预渲染的隐藏上传框误判为已登录', async (_name, adapter) => {
    let ticks = 0
    const page: BrowserPage = {
      goto: async () => undefined,
      url: () => adapter.publishPageUrl,
      waitForTimeout: async () => { ticks += 1 },
      locator(selector) {
        const isVideo = selector.includes('type="file"')
        const isLogin = selector.includes('登录')
        return locator({ present: isVideo || (isLogin && ticks > 0), visible: isLogin && ticks > 0 })
      },
    }

    await expect(adapter.inspect(page)).resolves.toBe('login_required')
  })

  it.each([
    ['douyin', douyinBrowserPublishAdapter],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter],
  ] as const)('%s 等待上传后的异步编辑器并校验填写结果', async (_name, adapter) => {
    const values: Record<string, string | string[]> = {}
    let editorReady = false
    const page = createFormPage(values, {
      pageUrl: adapter.publishPageUrl,
      editorReady: () => editorReady,
      waitForTimeout: async () => { editorReady = true },
    })

    await adapter.fillDraft(page, {
      platformId: adapter.platformId,
      publishPageUrl: adapter.publishPageUrl,
      videoPath: 'D:\\workspace\\final.mp4',
      title: '标题',
      description: '正文',
      tags: ['口播'],
    })

    expect(values.title).toBe('标题')
    expect(values.description).toBe('正文\n\n#口播')
  })

  it('填写被页面吞掉时不会报告为等待用户发布', async () => {
    const page = createFormPage({}, {
      pageUrl: douyinBrowserPublishAdapter.publishPageUrl,
      swallowFill: true,
    })
    await expect(douyinBrowserPublishAdapter.fillDraft(page, {
      platformId: 'douyin',
      publishPageUrl: douyinBrowserPublishAdapter.publishPageUrl,
      videoPath: 'D:\\workspace\\final.mp4',
      title: '标题',
      description: '正文',
      tags: [],
    })).rejects.toMatchObject({ code: 'browser_field_value_mismatch' })
  })

  it.each([
    ['douyin', douyinBrowserPublishAdapter],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter],
  ] as const)('%s 填写时允许官方发布路径携带 query、hash 和尾斜杠', async (_name, adapter) => {
    const values: Record<string, string | string[]> = {}
    const page = createFormPage(values, { pageUrl: `${adapter.publishPageUrl}/?from=koubo#draft` })

    await expect(adapter.fillDraft(page, draft(adapter))).resolves.toBeUndefined()
  })

  it.each([
    ['douyin', douyinBrowserPublishAdapter],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter],
  ] as const)('%s 上传前拒绝非官方 origin 或其他 pathname', async (_name, adapter) => {
    for (const pageUrl of [
      `https://attacker.example${new URL(adapter.publishPageUrl).pathname}`,
      `${adapter.publishPageUrl}/other`,
    ]) {
      const values: Record<string, string | string[]> = {}
      const error = await adapter.fillDraft(createFormPage(values, { pageUrl }), draft(adapter)).catch((reason) => reason)
      expect(error).toMatchObject({ code: 'browser_publish_page_mismatch' })
      expect(error.message).not.toContain(pageUrl)
      expect(values.video).toBeUndefined()
    }
  })

  it('inspect 不因登录重定向页面而提前阻断', async () => {
    const page: BrowserPage = {
      goto: async () => undefined,
      url: () => 'https://sso.douyin.com/login?redirect=creator',
      locator(selector) {
        const isLogin = selector.includes('登录')
        return locator({ present: isLogin, visible: isLogin })
      },
    }

    await expect(douyinBrowserPublishAdapter.inspect(page)).resolves.toBe('login_required')
  })

  it('全部字段填写后再次校验页面未被导航离开', async () => {
    let pageUrl = douyinBrowserPublishAdapter.publishPageUrl
    const page = createFormPage({}, {
      pageUrl: () => pageUrl,
      afterFill: (field) => {
        if (field === 'description') pageUrl = 'https://example.com/captured'
      },
    })

    await expect(douyinBrowserPublishAdapter.fillDraft(page, draft(douyinBrowserPublishAdapter)))
      .rejects.toMatchObject({ code: 'browser_publish_page_mismatch' })
  })

  it.each([
    ['set 失败', { uploadError: true }, 'browser_upload_failed'],
    ['回读不可用', { omitInputValue: true }, 'browser_upload_unverifiable'],
    ['回读失败', { uploadInputError: true }, 'browser_upload_unverifiable'],
    ['空文件', { uploadInputValue: '' }, 'browser_upload_empty'],
    ['文件不一致', { uploadInputValue: 'C:\\fakepath\\other.mp4' }, 'browser_upload_file_mismatch'],
  ] as const)('上传%s时返回稳定且不泄漏路径的错误', async (_name, testOptions, code) => {
    const videoPath = 'D:\\private-workspace\\secret-final.mp4'
    const page = createFormPage({}, {
      pageUrl: douyinBrowserPublishAdapter.publishPageUrl,
      ...testOptions,
    })
    const error = await douyinBrowserPublishAdapter.fillDraft(page, {
      ...draft(douyinBrowserPublishAdapter),
      videoPath,
    }).catch((reason) => reason)

    expect(error).toMatchObject({ code })
    expect(error.message).not.toContain(videoPath)
    expect(error.message).not.toContain('private-workspace')
  })
})

function createFormPage(values: Record<string, string | string[]>, options: {
  pageUrl?: string | (() => string)
  editorReady?: () => boolean
  waitForTimeout?: () => Promise<void>
  swallowFill?: boolean
  afterFill?: (field: string) => void
  uploadError?: boolean
  omitInputValue?: boolean
  uploadInputError?: boolean
  uploadInputValue?: string
} = {}): BrowserPage {
  return {
    goto: async () => undefined,
    url: () => typeof options.pageUrl === 'function'
      ? options.pageUrl()
      : options.pageUrl ?? 'https://creator.test/upload',
    waitForTimeout: options.waitForTimeout,
    locator(selector) {
      const field = selector.includes('type="file"') ? 'video'
        : selector.includes('title') || selector.includes('标题') ? 'title'
          : selector.includes('description') || selector.includes('描述') || selector.includes('正文') ? 'description'
            : undefined
      const ready = field === 'video' || !options.editorReady || options.editorReady()
      return createLocator(field, values, ready, options)
    },
  }
}

function createLocator(
  field: string | undefined,
  values: Record<string, string | string[]>,
  ready: boolean,
  options: {
    swallowFill?: boolean
    afterFill?: (field: string) => void
    uploadError?: boolean
    omitInputValue?: boolean
    uploadInputError?: boolean
    uploadInputValue?: string
  },
): BrowserLocator {
  const locator: BrowserLocator = {
    count: async () => field && ready ? 1 : 0,
    first() { return this },
    isVisible: async () => Boolean(field && ready),
    fill: async (value) => {
      if (field && !options.swallowFill) values[field] = value
      if (field) options.afterFill?.(field)
    },
    setInputFiles: async (files) => {
      if (options.uploadError) throw new Error('fixture upload failed')
      if (field) values[field] = files
    },
    inputValue: async () => typeof values[field ?? ''] === 'string' ? values[field ?? ''] as string : '',
    textContent: async () => typeof values[field ?? ''] === 'string' ? values[field ?? ''] as string : '',
    innerText: async () => typeof values[field ?? ''] === 'string' ? values[field ?? ''] as string : '',
  }
  if (field === 'video') {
    if (options.omitInputValue) locator.inputValue = undefined
    else if (options.uploadInputError) locator.inputValue = async () => { throw new Error('fixture input read failed') }
    else if (options.uploadInputValue !== undefined) locator.inputValue = async () => options.uploadInputValue ?? ''
  }
  return locator
}

function locator(input: { present: boolean; visible: boolean }): BrowserLocator {
  return {
    count: async () => input.present ? 1 : 0,
    first() { return this },
    isVisible: async () => input.visible,
    fill: async () => undefined,
    setInputFiles: async () => undefined,
    inputValue: async () => '',
    textContent: async () => '',
    innerText: async () => '',
  }
}

function draft(adapter: typeof douyinBrowserPublishAdapter | typeof xiaohongshuBrowserPublishAdapter) {
  return {
    platformId: adapter.platformId,
    publishPageUrl: adapter.publishPageUrl,
    videoPath: 'D:\\workspace\\final.mp4',
    title: '标题',
    description: '正文',
    tags: ['口播'],
  }
}
