import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exportOpenChatCutVideo,
  importOpenChatCutSource,
  inspectOpenChatCutTranscriptionStatus,
  openOpenChatCutProjectEditor,
  OpenChatCutCdpError,
  probeOpenChatCutExport,
  validateOpenChatCutEditorUrl,
} from './electron-cdp-adapter'

function fakeBrowser(input: {
  pageUrl?: string
  pageTitle?: string
  gotoError?: Error
  normalizeOk?: boolean
  suggestedFilename?: string
  downloadFailure?: string | null
  evaluateResult?: unknown
}) {
  const saveAs = vi.fn(async (target: string) => { await fs.writeFile(target, 'mp4') })
  const download = {
    suggestedFilename: () => input.suggestedFilename ?? 'video.mp4',
    saveAs,
    failure: vi.fn(async () => input.downloadFailure ?? null),
  }
  const checkbox = { waitFor: vi.fn(), isChecked: vi.fn(async () => false), check: vi.fn() }
  const locator = vi.fn((selector: string) => {
    if (selector.includes('qa-toggle')) return checkbox
    return { click: vi.fn(), setInputFiles: vi.fn() }
  })
  let url = input.pageUrl ?? 'http://127.0.0.1:5199/'
  const page = {
    url: () => url,
    title: vi.fn(async () => input.pageTitle ?? 'OpenChatCut'),
    reload: vi.fn(async () => undefined),
    goto: vi.fn(async (value: string) => {
      if (input.gotoError) throw input.gotoError
      url = value
    }),
    locator,
    waitForResponse: vi.fn(async () => ({
      url: () => 'http://127.0.0.1:5199/api/normalize-media',
      ok: () => input.normalizeOk ?? true,
      status: () => input.normalizeOk === false ? 500 : 200,
    })),
    waitForEvent: vi.fn(async () => download),
    evaluate: vi.fn(async () => input.evaluateResult),
  }
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: vi.fn(async () => undefined),
  }
  return {
    chromium: { connectOverCDP: vi.fn(async () => browser) },
    browser,
    page,
    checkbox,
    saveAs,
  }
}

describe('OpenChatCut Electron CDP adapter', () => {
  let root = ''
  let source = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchatcut-cdp-'))
    source = path.join(root, 'artifacts', 'render', 'source.mp4')
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.writeFile(source, 'source')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('accepts only the exact loopback project editor URL', () => {
    expect(validateOpenChatCutEditorUrl('http://127.0.0.1:5199/#/editor/project-1', 'project-1').hash).toBe('#/editor/project-1')
    expect(() => validateOpenChatCutEditorUrl('https://127.0.0.1:5199/#/editor/project-1', 'project-1')).toThrow()
    expect(() => validateOpenChatCutEditorUrl('http://evil.test/#/editor/project-1', 'project-1')).toThrow()
    expect(() => validateOpenChatCutEditorUrl('http://127.0.0.1:5199/#/editor/project-2', 'project-1')).toThrow()
  })

  it('opens only the root target at the exact project editor URL without touching media controls', async () => {
    const fake = fakeBrowser({ pageUrl: 'http://127.0.0.1:5199/' })

    await expect(openOpenChatCutProjectEditor({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
    }, { chromium: fake.chromium as never })).resolves.toEqual({ status: 'ok' })

    expect(fake.page.goto).toHaveBeenCalledWith(
      'http://127.0.0.1:5199/#/editor/project-1',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(fake.page.locator).not.toHaveBeenCalled()
    expect(fake.browser.close).toHaveBeenCalledTimes(1)

    const unrelated = fakeBrowser({ pageUrl: 'http://127.0.0.1:5199/projects' })
    await expect(openOpenChatCutProjectEditor({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
    }, { chromium: unrelated.chromium as never })).rejects.toMatchObject({
      code: 'cdp_target_mismatch',
    })
    expect(unrelated.page.goto).not.toHaveBeenCalled()
  })

  it('safely navigates the unique managed OpenChatCut page from a previous project', async () => {
    const fake = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/#/editor/previous-project',
      pageTitle: 'OpenChatCut',
    })

    await expect(openOpenChatCutProjectEditor({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
    }, { chromium: fake.chromium as never })).resolves.toEqual({ status: 'ok' })

    expect(fake.page.goto).toHaveBeenCalledWith(
      'http://127.0.0.1:5199/#/editor/project-1',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
    expect(fake.page.reload).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    )
  })

  it('rejects multiple same-origin OpenChatCut editor candidates', async () => {
    const first = fakeBrowser({ pageUrl: 'http://127.0.0.1:5199/#/editor/previous-1' })
    const second = fakeBrowser({ pageUrl: 'http://127.0.0.1:5199/#/editor/previous-2' })
    const browser = {
      contexts: () => [{ pages: () => [first.page, second.page] }],
      close: vi.fn(async () => undefined),
    }
    const chromium = { connectOverCDP: vi.fn(async () => browser) }

    await expect(openOpenChatCutProjectEditor({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
    }, { chromium: chromium as never })).rejects.toMatchObject({
      code: 'cdp_target_mismatch',
    })

    expect(first.page.goto).not.toHaveBeenCalled()
    expect(second.page.goto).not.toHaveBeenCalled()
  })

  it('returns only a sanitized auth failure for the exact project asset', async () => {
    const fake = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      evaluateResult: {
        status: 'failed',
        errorCode: 'auth',
        transcribeError: 'HTTP 401 api-key=must-not-leak',
      },
    })

    await expect(inspectOpenChatCutTranscriptionStatus({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      expectedSrc: '/media/uploads/current.mp4',
    }, { chromium: fake.chromium as never })).resolves.toEqual({
      status: 'failed',
      errorCode: 'auth',
    })
    expect(fake.page.evaluate).toHaveBeenCalledOnce()
    expect(fake.browser.close).toHaveBeenCalledOnce()
  })

  it('never reads IndexedDB from another project or an ambiguous editor page', async () => {
    const wrongProject = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/#/editor/project-2',
      evaluateResult: { status: 'failed', errorCode: 'auth' },
    })
    await expect(inspectOpenChatCutTranscriptionStatus({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      expectedSrc: '/media/uploads/current.mp4',
    }, { chromium: wrongProject.chromium as never })).rejects.toMatchObject({
      code: 'editor_navigation_mismatch',
    })
    expect(wrongProject.page.evaluate).not.toHaveBeenCalled()
    expect(wrongProject.page.goto).not.toHaveBeenCalled()

    const first = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      evaluateResult: { status: 'failed', errorCode: 'auth' },
    })
    const second = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/#/editor/project-2',
      evaluateResult: { status: 'failed', errorCode: 'auth' },
    })
    const browser = {
      contexts: () => [{ pages: () => [first.page, second.page] }],
      close: vi.fn(async () => undefined),
    }
    await expect(inspectOpenChatCutTranscriptionStatus({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      expectedSrc: '/media/uploads/current.mp4',
    }, {
      chromium: { connectOverCDP: vi.fn(async () => browser) } as never,
    })).rejects.toMatchObject({ code: 'cdp_target_mismatch' })
    expect(first.page.evaluate).not.toHaveBeenCalled()
    expect(second.page.evaluate).not.toHaveBeenCalled()
  })

  it('closes the CDP browser once and returns a stable error when editor navigation fails', async () => {
    const fake = fakeBrowser({
      pageUrl: 'http://127.0.0.1:5199/',
      gotoError: new Error('navigation aborted'),
    })

    await expect(openOpenChatCutProjectEditor({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
    }, { chromium: fake.chromium as never })).rejects.toMatchObject({
      code: 'editor_navigation_failed',
    })
    expect(fake.browser.close).toHaveBeenCalledTimes(1)
  })

  it('imports only a workspace file through the fixed empty-canvas selector', async () => {
    const fake = fakeBrowser({})
    await expect(importOpenChatCutSource({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      sourcePath: source,
      timelineEmptyConfirmed: true,
    }, { chromium: fake.chromium as never })).resolves.toEqual({ status: 'ok' })
    expect(fake.page.locator).toHaveBeenCalledWith('.cc-preview-stage input[type=file]')
  })

  it('rejects a mismatching CDP target and an outside source path', async () => {
    const mismatch = fakeBrowser({ pageUrl: 'http://127.0.0.1:6000/' })
    await expect(importOpenChatCutSource({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      sourcePath: source,
      timelineEmptyConfirmed: true,
    }, { chromium: mismatch.chromium as never })).rejects.toMatchObject({ code: 'cdp_target_mismatch' })
    await expect(importOpenChatCutSource({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      sourcePath: path.join(os.tmpdir(), 'outside.mp4'),
      timelineEmptyConfirmed: true,
    }, { chromium: fakeBrowser({}).chromium as never })).rejects.toThrow()
  })

  it('keeps manual takeover available when media normalization fails', async () => {
    const fake = fakeBrowser({ normalizeOk: false })
    await expect(importOpenChatCutSource({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      sourcePath: source,
      timelineEmptyConfirmed: true,
    }, { chromium: fake.chromium as never })).rejects.toMatchObject({ code: 'normalize_media_failed' })
  })

  it('exports with QA enabled, validates MP4 and atomically commits the final file', async () => {
    const fake = fakeBrowser({})
    const result = await exportOpenChatCutVideo({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      artifactId: 'post-1',
    }, {
      chromium: fake.chromium as never,
      probeExportMedia: vi.fn(async () => ({ codec: 'h264' as const, durationSeconds: 12 })),
    })
    expect(result.outputPath).toBe(path.join(root, 'artifacts', 'post-production', 'post-1.mp4'))
    expect(fake.page.locator).toHaveBeenCalledWith('button[title="导出 MP4"]')
    expect(fake.page.locator).toHaveBeenCalledWith('.cc-export-qa-toggle input')
    expect(fake.page.locator).toHaveBeenCalledWith('.cc-export-cta')
    expect(fake.checkbox.check).toHaveBeenCalled()
    await expect(fs.readFile(result.outputPath, 'utf8')).resolves.toBe('mp4')
  })

  it('does not leave a final artifact when download validation fails', async () => {
    const fake = fakeBrowser({ suggestedFilename: 'video.webm' })
    await expect(exportOpenChatCutVideo({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      artifactId: 'post-failed',
    }, { chromium: fake.chromium as never })).rejects.toMatchObject({ code: 'invalid_export_format' })
    await expect(fs.stat(path.join(root, 'artifacts', 'post-production', 'post-failed.mp4'))).rejects.toThrow()
  })

  it('rejects a non-H264 video stream without committing the final file', async () => {
    const fake = fakeBrowser({})
    await expect(exportOpenChatCutVideo({
      cdpPort: 43210,
      editorUrl: 'http://127.0.0.1:5199/#/editor/project-1',
      openChatCutProjectId: 'project-1',
      workspaceRoot: root,
      artifactId: 'post-codec-failed',
    }, {
      chromium: fake.chromium as never,
      probeExportMedia: vi.fn(async () => {
        throw new OpenChatCutCdpError('export_codec_invalid', '不是 H.264')
      }),
    })).rejects.toMatchObject({ code: 'export_codec_invalid' })
    await expect(fs.stat(path.join(root, 'artifacts', 'post-production', 'post-codec-failed.mp4'))).rejects.toThrow()
  })

  it('uses one bounded ffprobe call to validate duration and H.264 together', async () => {
    const child = fakeProcess(4312)
    const spawnProcess = vi.fn(() => child.process)
    const result = probeOpenChatCutExport(source, {
      spawnProcess: spawnProcess as never,
      timeoutMs: 1_000,
    })
    child.stdout.end(JSON.stringify({
      format: { duration: '12.5' },
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
    }))
    child.process.emit('close', 0)
    await expect(result).resolves.toEqual({ codec: 'h264', durationSeconds: 12.5 })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect((spawnProcess.mock.calls as unknown[][])[0]?.[1]).toContain('format=duration:stream=codec_name,codec_type')
  })

  it('times out once and terminates the direct process when taskkill fails on Windows', async () => {
    const child = fakeProcess(4312)
    const killer = fakeProcess(9876)
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(child.process)
      .mockReturnValueOnce(killer.process)
    const result = probeOpenChatCutExport(source, {
      spawnProcess: spawnProcess as never,
      timeoutMs: 5,
      platform: 'win32',
    })
    const assertion = expect(result).rejects.toMatchObject({ code: 'media_probe_timeout' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    killer.process.emit('close', 1)
    await assertion
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/PID', '4312', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
    )
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})

function fakeProcess(pid: number) {
  const process = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  process.pid = pid
  process.stdout = new PassThrough()
  process.stderr = new PassThrough()
  const kill = vi.fn(() => true)
  process.kill = kill
  return { process, stdout: process.stdout, stderr: process.stderr, kill }
}
