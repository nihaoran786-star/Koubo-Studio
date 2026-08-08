import type { BrowserLocator, BrowserPage } from './types'

export async function hasVisible(page: BrowserPage, selectors: readonly string[]) {
  return Boolean(await findVisible(page, selectors))
}

export async function hasPresent(page: BrowserPage, selectors: readonly string[]) {
  return Boolean(await findPresent(page, selectors))
}

export async function waitForPageReadiness(
  page: BrowserPage,
  authenticatedSelectors: readonly string[],
  loginSelectors: readonly string[],
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout
  while (true) {
    // A hidden upload input may be pre-rendered on a login shell. Requiring a
    // visible authenticated control avoids reporting a false logged-in state.
    if (await hasVisible(page, authenticatedSelectors)) return 'ready_to_fill' as const
    if (await hasVisible(page, loginSelectors)) return 'login_required' as const
    if (!page.waitForTimeout || Date.now() >= deadline) break
    await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())))
  }
  throw new BrowserAdapterError(
    'browser_page_unrecognized',
    '平台页面尚未加载完成，或页面结构已经变化。请检查浏览器中的登录、网络或风控提示。',
  )
}

export async function requirePresent(
  page: BrowserPage,
  selectors: readonly string[],
  fieldName: string,
): Promise<BrowserLocator> {
  const locator = await waitForLocator(page, selectors, 'present')
  if (!locator) {
    throw new BrowserAdapterError('browser_field_not_found', `未找到${fieldName}，平台页面可能已更新。`)
  }
  return locator
}

export async function requireVisible(
  page: BrowserPage,
  selectors: readonly string[],
  fieldName: string,
): Promise<BrowserLocator> {
  const locator = await waitForLocator(page, selectors, 'visible')
  if (!locator) {
    throw new BrowserAdapterError('browser_field_not_found', `未找到${fieldName}，平台页面可能已更新。`)
  }
  return locator
}

export async function fillAndVerify(
  page: BrowserPage,
  selectors: readonly string[],
  fieldName: string,
  value: string,
) {
  const locator = await requireVisible(page, selectors, fieldName)
  await locator.fill(value)
  // Framework editors often replace the node after input. Resolve it again
  // and verify the rendered value instead of assuming fill succeeded.
  const current = await requireVisible(page, selectors, fieldName)
  const actualValues = await readValues(current)
  const expected = normalizeFieldValue(value)
  if (!actualValues.some((actual) => normalizeFieldValue(actual) === expected)) {
    throw new BrowserAdapterError('browser_field_value_mismatch', `${fieldName}未能稳定写入，请在浏览器中检查后重试。`)
  }
}

export function assertOfficialPublishPage(page: BrowserPage, expectedPageUrl: string) {
  let actual: URL
  let expected: URL
  try {
    actual = new URL(page.url())
    expected = new URL(expectedPageUrl)
  } catch {
    throw new BrowserAdapterError(
      'browser_publish_page_mismatch',
      '当前页面不是平台官方发布页，请返回应用重新打开发布页。',
    )
  }

  if (actual.origin !== expected.origin || normalizePathname(actual.pathname) !== normalizePathname(expected.pathname)) {
    throw new BrowserAdapterError(
      'browser_publish_page_mismatch',
      '当前页面不是平台官方发布页，请返回应用重新打开发布页。',
    )
  }
}

export async function uploadAndVerify(
  page: BrowserPage,
  selectors: readonly string[],
  fieldName: string,
  filePath: string,
) {
  const locator = await requirePresent(page, selectors, fieldName)
  try {
    await locator.setInputFiles(filePath)
  } catch {
    throw new BrowserAdapterError('browser_upload_failed', `${fieldName}选择失败，请在浏览器中检查后重试。`)
  }

  if (!locator.inputValue) {
    throw new BrowserAdapterError('browser_upload_unverifiable', `${fieldName}无法校验，请检查平台页面是否已更新。`)
  }

  let selectedValue: string
  try {
    selectedValue = await locator.inputValue()
  } catch {
    throw new BrowserAdapterError('browser_upload_unverifiable', `${fieldName}无法校验，请检查平台页面是否已更新。`)
  }

  if (!selectedValue.trim()) {
    throw new BrowserAdapterError('browser_upload_empty', `${fieldName}没有选中文件，请重试。`)
  }
  if (basename(selectedValue) !== basename(filePath)) {
    throw new BrowserAdapterError('browser_upload_file_mismatch', `${fieldName}选中的文件不正确，请重试。`)
  }
}

async function waitForLocator(
  page: BrowserPage,
  selectors: readonly string[],
  state: 'present' | 'visible',
  timeout = 90_000,
) {
  const deadline = Date.now() + timeout
  while (true) {
    const locator = state === 'visible'
      ? await findVisible(page, selectors)
      : await findPresent(page, selectors)
    if (locator) return locator
    if (!page.waitForTimeout || Date.now() >= deadline) return undefined
    await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())))
  }
}

async function readValues(locator: BrowserLocator) {
  const values: string[] = []
  if (locator.inputValue) {
    const value = await locator.inputValue().catch(() => undefined)
    if (value !== undefined) values.push(value)
  }
  if (locator.textContent) {
    const value = await locator.textContent().catch(() => undefined)
    if (value !== undefined && value !== null) values.push(value)
  }
  if (locator.innerText) {
    const value = await locator.innerText().catch(() => undefined)
    if (value !== undefined) values.push(value)
  }
  if (values.length === 0) {
    throw new BrowserAdapterError('browser_field_value_unverifiable', '平台输入框无法校验，请检查页面是否已更新。')
  }
  return values
}

function normalizeFieldValue(value: string) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizePathname(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).at(-1) ?? ''
}

async function findVisible(page: BrowserPage, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if ((await locator.count()) > 0 && await locator.isVisible().catch(() => false)) return locator
  }
  return undefined
}

async function findPresent(page: BrowserPage, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if ((await locator.count()) > 0) return locator
  }
  return undefined
}

export function combineDescription(description: string, tags: string[]) {
  const normalizedTags = tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith('#') ? tag : `#${tag}`)
  return [description.trim(), normalizedTags.join(' ')].filter(Boolean).join('\n\n')
}

export class BrowserAdapterError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserAdapterError'
  }
}
