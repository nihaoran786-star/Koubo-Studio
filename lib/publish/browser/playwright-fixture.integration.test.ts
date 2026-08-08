import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright-core'
import { douyinBrowserPublishAdapter } from './adapters/douyin'
import { xiaohongshuBrowserPublishAdapter } from './adapters/xiaohongshu'
import { resolveBrowserExecutable } from './runtime'
import type { BrowserPage, BrowserPublishAdapter } from './types'

let browser: Browser
let tempRoot: string
let videoPath: string

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-browser-fixture-'))
  videoPath = path.join(tempRoot, 'fixture.mp4')
  await fs.writeFile(videoPath, 'fixture-video')
  browser = await chromium.launch({ executablePath: await resolveBrowserExecutable(), headless: true })
})

afterAll(async () => {
  await browser?.close()
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('browser publish adapter real Playwright fixture', () => {
  it.each([
    ['douyin', douyinBrowserPublishAdapter, '扫码登录'],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter, '手机号登录'],
  ] as const)('%s waits for delayed login and ignores a hidden uploader', async (_name, adapter, loginText) => {
    const page = await browser.newPage()
    await fulfillOfficialPage(page, adapter, `
      <input type="file" accept="video/mp4" hidden>
      <script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button>${loginText}</button>'), 120)</script>
    `)
    const browserPage = page as unknown as BrowserPage
    await adapter.open(browserPage)
    await expect(adapter.inspect(browserPage)).resolves.toBe('login_required')
    await page.close()
  })

  it.each([
    ['douyin', douyinBrowserPublishAdapter, '作品标题', '作品描述'],
    ['xiaohongshu', xiaohongshuBrowserPublishAdapter, '填写标题', '正文'],
  ] as const)('%s waits for the upload editor and verifies native/contenteditable values', async (
    _name,
    adapter,
    titlePlaceholder,
    descriptionPlaceholder,
  ) => {
    const page = await browser.newPage()
    await fulfillOfficialPage(page, adapter, `
      <input id="video" type="file" accept="video/mp4">
      <script>
        document.querySelector('#video').addEventListener('change', () => setTimeout(() => {
          document.body.insertAdjacentHTML('beforeend',
            '<input id="title" placeholder="${titlePlaceholder}">' +
            '<div id="description" contenteditable="true" data-placeholder="${descriptionPlaceholder}"></div>')
        }, 120))
      </script>
    `)
    const browserPage = page as unknown as BrowserPage
    await adapter.open(browserPage)
    await expect(adapter.inspect(browserPage)).resolves.toBe('ready_to_fill')
    await adapter.fillDraft(browserPage, draft(adapter))

    expect(await page.locator('#title').inputValue()).toBe('Fixture 标题')
    expect((await page.locator('#description').innerText()).replace(/\s+/g, ' ').trim()).toBe('Fixture 正文 #口播')
    await page.close()
  })
})

function draft(adapter: BrowserPublishAdapter) {
  return {
    platformId: adapter.platformId,
    publishPageUrl: adapter.publishPageUrl,
    videoPath,
    title: 'Fixture 标题',
    description: 'Fixture 正文',
    tags: ['口播'],
  }
}

async function fulfillOfficialPage(
  page: Awaited<ReturnType<Browser['newPage']>>,
  adapter: BrowserPublishAdapter,
  body: string,
) {
  await page.route(adapter.publishPageUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body>${body}</body></html>`,
    })
  })
}
