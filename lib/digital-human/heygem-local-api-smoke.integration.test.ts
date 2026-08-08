import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { createProjectState, mutateProjectState } from '@/lib/project-state/project-state-service'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { emptyScript } from '@/lib/workspace'
import { saveAvatarAsset } from './avatar-asset'
import { generateHeyGemRender } from './heygem-service'

const execFileAsync = promisify(execFile)
const projectId = 'heygem-local-api-smoke'
const shouldRun = process.env.RUN_HEYGEM_LOCAL_API_SMOKE === '1'
const maybeIt = shouldRun ? it : it.skip

afterEach(async () => {
  delete process.env.HEYGEM_API_URL
  delete process.env.DUIX_AVATAR_API_URL
  delete process.env.DUIX_AVATAR_API_DIALECT
  delete process.env.DUIX_AVATAR_RESULT_ROOT
  delete process.env.DUIX_AVATAR_HOST_DATA_ROOT
  delete process.env.DUIX_AVATAR_CONTAINER_DATA_ROOT
  delete process.env.DUIX_AVATAR_PUBLIC_ASSET_BASE_URL
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('HeyGem local API smoke', () => {
  maybeIt('renders through a local HeyGem-compatible API and saves a render artifact', async () => {
    const server = await createLocalHeyGemApi()
    delete process.env.DUIX_AVATAR_API_URL
    delete process.env.DUIX_AVATAR_API_DIALECT
    delete process.env.DUIX_AVATAR_RESULT_ROOT
    delete process.env.DUIX_AVATAR_HOST_DATA_ROOT
    delete process.env.DUIX_AVATAR_CONTAINER_DATA_ROOT
    delete process.env.DUIX_AVATAR_PUBLIC_ASSET_BASE_URL
    process.env.HEYGEM_API_URL = server.baseUrl

    try {
      const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
      await saveScriptArtifact({
        workspace,
        artifactId: 'script-smoke',
        sessionId: 'script-session',
        approvalStatus: 'approved',
        content: {
          title: 'HeyGem smoke',
          hook: '这是一次数字人 smoke。',
          body: '这是一次本地 HeyGem compatible API 数字人生成 smoke。',
          caption: 'HeyGem smoke',
          tags: ['#smoke'],
          durationSeconds: 1,
          voiceNotes: '',
          shotNotes: '',
          riskNotes: '',
        },
      })
      await createProjectState({
        projectId,
        script: {
          ...emptyScript(),
          artifactId: 'script-smoke',
          approvalStatus: 'approved',
          title: 'HeyGem smoke',
          body: '这是一次本地 HeyGem compatible API 数字人生成 smoke。',
          generated: true,
        },
      })
      await saveAudioArtifact({
        workspace,
        artifactId: 'audio-smoke',
        sessionId: 'voice-session',
        status: 'ready',
        source: 'indextts2',
        outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-smoke.wav'),
        durationSeconds: 1,
        parameters: {
          scriptArtifactId: 'script-smoke',
          text: '这是一次本地 HeyGem compatible API 数字人生成 smoke。',
          speed: 1,
          emotionAlpha: 0.2,
          useRandom: false,
          outputFormat: 'wav',
        },
      })
      await mutateProjectState(projectId, {
        operation: 'select_artifact',
        stage: 'voice',
        artifactId: 'audio-smoke',
      })
      const avatarFixturePath = path.join(workspace.filesPath, 'avatar-fixture.mp4')
      await execFileAsync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-pix_fmt', 'yuv420p', avatarFixturePath,
      ])
      const avatar = await saveAvatarAsset({
        workspace,
        originalFilename: 'avatar-fixture.mp4',
        contentType: 'video/mp4',
        bytes: new Uint8Array(await fs.readFile(avatarFixturePath)),
      })
      await fs.rm(avatarFixturePath, { force: true })

      const result = await generateHeyGemRender({
        projectId,
        sessionId: 'avatar-session',
        input: {
          avatarAssetId: avatar.asset.assetId,
          mode: 'standard',
        },
      })

      expect(result.status).toBe('ok')
      if (result.status !== 'ok') throw new Error(JSON.stringify(result))
      expect(result.artifact).toMatchObject({
        artifactType: 'render',
        status: 'ready',
        source: 'heygem',
        scriptArtifactId: 'script-smoke',
        audioArtifactId: 'audio-smoke',
      })
      expect(result.artifact.durationSeconds).toBeGreaterThan(0)
      await expect(fs.stat(result.artifact.outputPath)).resolves.toMatchObject({
        size: expect.any(Number),
      })
    } finally {
      await server.close()
    }
  }, 60000)
})

async function createLocalHeyGemApi() {
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/render') {
      response.writeHead(404).end()
      return
    }

    try {
      const body = JSON.parse(await readRequestBody(request)) as { outputPath?: string }
      if (!body.outputPath) throw new Error('outputPath is required')
      await fs.mkdir(path.dirname(body.outputPath), { recursive: true })
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=720x1280:d=1',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=mono:sample_rate=24000',
        '-shortest',
        '-pix_fmt',
        'yuv420p',
        body.outputPath,
      ])
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', outputPath: body.outputPath }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        status: 'adapter_error',
        error: {
          code: 'runtime_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind local HeyGem API')

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function readRequestBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}
