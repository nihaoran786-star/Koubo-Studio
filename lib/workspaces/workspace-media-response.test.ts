import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceGuardError } from './workspace-guard'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from './workspace-media-response'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('createWorkspaceMediaResponse', () => {
  it('streams the complete file with stable media headers', async () => {
    const { root, filePath } = await fixture('01234567')
    const response = await createWorkspaceMediaResponse({
      rootPath: root,
      filePath,
      contentType: 'video/mp4',
      acceptRanges: true,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('8')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('01234567')
  })

  it('streams only the requested byte range', async () => {
    const { root, filePath } = await fixture('01234567')
    const response = await createWorkspaceMediaResponse({
      rootPath: root,
      filePath,
      contentType: 'video/mp4',
      rangeEnabled: true,
      acceptRanges: true,
      rangeHeader: 'bytes=2-4',
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-4/8')
    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('234')
  })

  it('rejects invalid and unsatisfiable ranges before opening a stream', async () => {
    const { root, filePath } = await fixture('01234567')
    for (const rangeHeader of ['bytes=9-', 'bytes=4-2', 'bytes=-3', 'items=0-2']) {
      await expect(createWorkspaceMediaResponse({
        rootPath: root,
        filePath,
        contentType: 'video/mp4',
        rangeEnabled: true,
        rangeHeader,
      })).rejects.toMatchObject({ code: 'invalid_range' } satisfies Partial<WorkspaceMediaResponseError>)
    }
  })

  it('rejects paths outside the workspace root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-root-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-outside-'))
    roots.push(root, outside)
    const filePath = path.join(outside, 'video.mp4')
    await fs.writeFile(filePath, 'video')

    await expect(createWorkspaceMediaResponse({ rootPath: root, filePath, contentType: 'video/mp4' }))
      .rejects.toBeInstanceOf(WorkspaceGuardError)
  })

  it('classifies missing files and directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-root-'))
    roots.push(root)

    await expect(createWorkspaceMediaResponse({
      rootPath: root,
      filePath: path.join(root, 'missing.mp4'),
      contentType: 'video/mp4',
    })).rejects.toMatchObject({ code: 'file_not_found' } satisfies Partial<WorkspaceMediaResponseError>)

    await expect(createWorkspaceMediaResponse({
      rootPath: root,
      filePath: root,
      contentType: 'video/mp4',
    })).rejects.toMatchObject({ code: 'not_a_file' } satisfies Partial<WorkspaceMediaResponseError>)
  })

  it('rejects a final symbolic link even when it resolves inside the root', async () => {
    const { root, filePath } = await fixture('01234567')
    const linkedPath = path.join(root, 'linked.mp4')
    try {
      await fs.symlink(filePath, linkedPath, 'file')
    } catch (error) {
      if (isWindowsLinkPermissionError(error)) return
      throw error
    }

    await expect(createWorkspaceMediaResponse({
      rootPath: root,
      filePath: linkedPath,
      contentType: 'video/mp4',
    })).rejects.toMatchObject({ code: 'not_a_file' } satisfies Partial<WorkspaceMediaResponseError>)
  })

  it('rejects a parent link that resolves outside the authorised root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-root-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-outside-'))
    roots.push(root, outside)
    await fs.writeFile(path.join(outside, 'video.mp4'), 'outside')
    const linkedDirectory = path.join(root, 'linked-directory')
    try {
      await fs.symlink(outside, linkedDirectory, 'junction')
    } catch (error) {
      if (isWindowsLinkPermissionError(error)) return
      throw error
    }

    await expect(createWorkspaceMediaResponse({
      rootPath: root,
      filePath: path.join(linkedDirectory, 'video.mp4'),
      contentType: 'video/mp4',
    })).rejects.toBeInstanceOf(WorkspaceGuardError)
  })
})

async function fixture(contents: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-media-'))
  roots.push(root)
  const filePath = path.join(root, 'video.mp4')
  await fs.writeFile(filePath, contents)
  return { root, filePath }
}

function isWindowsLinkPermissionError(error: unknown) {
  return process.platform === 'win32' && Boolean(
    error && typeof error === 'object' && 'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES'),
  )
}
