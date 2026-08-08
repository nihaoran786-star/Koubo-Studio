import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserPage, BrowserRuntime, BrowserSession } from './types'

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  async openPersistentContext(input: {
    executablePath: string
    profilePath: string
  }): Promise<BrowserSession> {
    const { chromium } = await import('playwright-core')
    const context = await chromium.launchPersistentContext(input.profilePath, {
      executablePath: input.executablePath,
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    })
    const pages = context.pages()
    const page = pages[0] ?? await context.newPage()
    return {
      page: page as unknown as BrowserPage,
      close: () => context.close(),
      onClosed(listener) {
        context.on('close', listener)
        return () => context.off('close', listener)
      },
    }
  }
}

export async function resolveBrowserExecutable() {
  const configured = process.env.KOUBO_BROWSER_EXECUTABLE?.trim()
  const candidates = configured ? [configured] : systemBrowserCandidates()
  for (const candidate of candidates) {
    if (await isFile(candidate)) return path.resolve(candidate)
  }
  throw new BrowserRuntimeError(
    'browser_executable_not_found',
    configured
      ? 'KOUBO_BROWSER_EXECUTABLE 指向的浏览器不存在。'
      : '未找到可用的 Microsoft Edge 或 Google Chrome。',
  )
}

function systemBrowserCandidates() {
  const local = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  return [
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFiles && path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFiles && path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

async function isFile(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch {
    return false
  }
}

export class BrowserRuntimeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserRuntimeError'
  }
}
