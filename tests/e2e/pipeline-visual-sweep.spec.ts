import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const screenshotDir = path.join(process.cwd(), 'test-results', 'visual-sweep')
const fixtureDir = path.join(process.cwd(), 'test-results', 'visual-sweep-fixtures')

test.afterEach(async () => {
  await fs.rm(screenshotDir, { recursive: true, force: true })
  await fs.rm(fixtureDir, { recursive: true, force: true })
})

test('digital-human pipeline visual sweep covers script, audio, avatar, post-production, publish, and cleanup', async ({ page }) => {
  await mockRuntimeReadiness(page)
  await mockEmptyLatestAudio(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUploads(page)
  await mockScriptAgent(page)
  await mockIndexTTS2(page)
  await mockHeyGem(page)
  await mockPostProductionAgent(page)
  await mockPublishAgent(page)

  await openDigitalHumanFlow(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await expect(page.getByText('如果你刚开始接触 Codex，先把目标说清楚。')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认文案' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步' })).toBeHidden()
  await takeEvidenceScreenshot(page, '01-script-generated.png')

  await page.getByRole('button', { name: '确认文案' }).click()
  await expect(page.getByRole('button', { name: '已确认文案' })).toBeVisible()
  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('IndexTTS2 运行环境未就绪')).toBeVisible()
  await expect(page.getByText('缺少 RUN_INDEXTTS2_INTEGRATION=1')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  await expect(page.getByText('Pi、IndexTTS2、HeyGem、后期、发布和桌面包的本机前置条件。')).toBeVisible()
  await page.getByRole('button', { name: '返回当前创作 · 声音' }).click()
  await expect(page.getByText('IndexTTS2 运行环境未就绪')).toBeVisible()
  await expect(page.getByLabel('语速')).toBeVisible()
  await uploadVoiceReference(page)
  await page.getByLabel('语速').fill('1.25')
  await page.getByLabel('情绪强度').fill('0.35')
  await page.getByLabel('情绪提示').fill('自然、清晰、稳定，略带热情')
  await page.getByLabel('10 秒测试音频').check()
  await takeEvidenceScreenshot(page, '02-voice-parameters.png')
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()
  await expect(page.getByText('时长 8.2 秒')).toBeVisible()
  await expect(page.locator('audio[aria-label="试听生成音频"]')).toBeVisible()
  await takeEvidenceScreenshot(page, '03-voice-ready.png')

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('请上传正脸视频形象后生成数字人。')).toBeVisible()
  await takeEvidenceScreenshot(page, '04-avatar-upload-required.png')
  await uploadAvatarVideo(page)
  await takeEvidenceScreenshot(page, '05-avatar-ready-to-generate.png')
  await page.getByRole('button', { name: '生成' }).click()
  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeVisible()
  await takeEvidenceScreenshot(page, '06-avatar-render-ready.png')

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('后期智能体会基于数字人视频、文案和当前样式生成成片。')).toBeVisible()
  await page.getByRole('button', { name: '导出成片' }).click()
  await expect(page.getByText('Skill 调用 · post-production-cut-review')).toBeVisible()
  await expect(page.getByText('已生成后期成片 artifact：post-e2e')).toBeVisible()
  await takeEvidenceScreenshot(page, '07-post-production-skill.png')

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('这里只生成本地发布包。浏览器登录、验证码和最终发布均由你监督并确认。')).toBeVisible()
  await page.getByRole('button', { name: '准备发布包' }).click()
  await expect(page.getByText('发布包已准备')).toBeVisible()
  await expect(page.getByRole('link', { name: '抖音发布页' })).toBeVisible()
  await expect(page.getByRole('link', { name: '小红书发布页' })).toBeVisible()
  await expect(page.getByText('当前只打开官方发布页，不会读取密码、绕过验证或自动点击最终发布。')).toBeVisible()
  await takeEvidenceScreenshot(page, '08-local-publish-package-manual-required.png')
})
test('digital-human visual sweep covers script and HeyGem failure recovery states', async ({ page }) => {
  await mockRuntimeReadiness(page)
  await mockEmptyLatestAudio(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUploads(page)
  await mockScriptAgent(page)
  await mockIndexTTS2(page)
  await mockHeyGemError(page)

  await openDigitalHumanFlow(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await page.getByRole('button', { name: '确认文案' }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()
  await page.getByRole('button', { name: '下一步' }).click()
  await uploadAvatarVideo(page)
  await page.getByRole('button', { name: '生成' }).click()

  await expect(page.getByText('HeyGem runtime/API 不可用，请检查本地服务、脚本路径或端口配置。')).toBeVisible()
  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeHidden()
  await takeEvidenceScreenshot(page, '11-avatar-runtime-error.png')
})

async function openDigitalHumanFlow(page: Page) {
  await page.goto('/')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: /数字人视频/ }).click()
}

async function takeEvidenceScreenshot(page: Page, filename: string) {
  await fs.mkdir(screenshotDir, { recursive: true })
  const filePath = path.join(screenshotDir, filename)
  await page.screenshot({ path: filePath, fullPage: true })
  await expect.poll(async () => fs.stat(filePath).then((stat) => stat.size)).toBeGreaterThan(0)
}

async function mockRuntimeReadiness(page: Page) {
  await page.route('**/api/settings/runtime-readiness', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'missing',
        source: 'runtime_readiness',
        profile: runtimeProfileFixture(),
        updatedAt: '2026-06-11T00:00:00.000Z',
        summary: { ready: 4, missing: 2, warning: 0 },
        checks: [
          runtimeCheck('model_provider', 'AI 文案 Provider', 'ready', [], '打开设置并测试连接'),
          runtimeCheck('indextts2', 'IndexTTS2', 'missing', ['缺少 RUN_INDEXTTS2_INTEGRATION=1'], 'pnpm smoke:indextts2'),
          runtimeCheck('heygem', 'HeyGem', 'ready', [], 'pnpm smoke:heygem-runtime'),
          runtimeCheck('post_production', 'Post-production', 'ready', [], 'pnpm smoke:post-production-local-skill'),
          runtimeCheck('browser_publish', '抖音 / 小红书发布准备', 'ready', [], 'pnpm runtime:doctor'),
          runtimeCheck('desktop_release', 'Desktop release', 'missing', ['缺少 RUN_DESKTOP_RELEASE_SMOKE=1'], 'pnpm smoke:desktop-release'),
        ],
      }),
    })
  })
}

function runtimeCheck(id: string, title: string, status: string, gaps: string[], command: string) {
  return {
    id,
    title,
    status,
    requiredForCurrentProfile: status !== 'warning',
    optionalForCurrentProfile: status === 'warning',
    gaps,
    nextStep: `运行 ${command}。`,
    provisioning: {
      priority: 1,
      stage: title,
      required: [`${title} runtime`],
      sensitiveEnvKeys: [],
      safeEvidence: '只保留非敏感测试状态。',
    },
    remediation: {
      envKeys: [],
      envTemplate: '',
      command,
      docPath: 'docs/SMOKE_TESTS.md',
    },
  }
}

function runtimeProfileFixture() {
  return {
    id: 'full',
    title: '完整验收',
    description: '要求所有本地/远程 runtime 和真实 UI evidence 前置条件齐备。',
    requiredCheckIds: ['model_provider', 'indextts2', 'heygem', 'post_production', 'browser_publish', 'desktop_release'],
  }
}

async function mockEmptyLatestAudio(page: Page) {
  await page.route('**/api/projects/*/audio-artifacts/latest', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'not_found',
        source: 'audio_artifact_query',
        error: {
          code: 'audio_artifact_not_found',
          message: '未找到可恢复的音频 artifact。',
        },
      }),
    })
  })
  await page.route('**/api/projects/*/audio-artifacts/*/file', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      body: Buffer.from('fake wav'),
    })
  })
}

async function uploadVoiceReference(page: Page) {
  const referenceFile = await createAudioFixture('reference.wav')
  const uploadMode = page.getByRole('button', { name: '上传音频' })
  if (await uploadMode.isVisible()) {
    await uploadMode.click()
  }
  await page.getByLabel('上传声音参考音频').setInputFiles(referenceFile)
  await expect(page.getByText('参考音频：reference.wav')).toBeVisible()
}

async function uploadAvatarVideo(page: Page) {
  const avatarFile = await createVideoFixture('avatar.mp4')
  await page.getByLabel('上传数字人形象视频').setInputFiles(avatarFile)
  await expect(page.getByText('avatar.mp4')).toBeVisible()
}

async function mockAudioAssetUploads(page: Page) {
  await page.route('**/api/projects/*/audio-assets', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'audio_asset',
        asset: {
          assetId: 'reference-e2e',
          assetType: 'audio',
          projectId: 'demo',
          featureType: 'digital-human',
          purpose: 'reference',
          originalFilename: 'reference.wav',
          contentType: 'audio/wav',
          relativePath: 'files/audio/reference-e2e.wav',
          path: 'C:/workspace/files/audio/reference-e2e.wav',
          size: 16,
          status: 'ready',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockAvatarAssetUploads(page: Page) {
  await page.route('**/api/projects/*/avatar-assets', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'avatar_asset',
        asset: {
          assetId: 'avatar-e2e',
          assetType: 'avatar',
          projectId: 'demo',
          featureType: 'digital-human',
          originalFilename: 'avatar.mp4',
          contentType: 'video/mp4',
          relativePath: 'files/avatars/avatar-e2e.mp4',
          path: 'C:/workspace/files/avatars/avatar-e2e.mp4',
          size: 16,
          status: 'ready',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function createAudioFixture(filename: string) {
  await fs.mkdir(fixtureDir, { recursive: true })
  const filePath = path.join(fixtureDir, filename)
  await fs.writeFile(filePath, Buffer.from('fake wav fixture'))
  return filePath
}

async function createVideoFixture(filename: string) {
  await fs.mkdir(fixtureDir, { recursive: true })
  const filePath = path.join(fixtureDir, filename)
  await fs.writeFile(filePath, Buffer.from('fake mp4 fixture'))
  return filePath
}

async function mockScriptAgent(page: Page) {
  await page.route('**/api/projects/*/script-agent', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          artifact: {
            artifactId: 'script-e2e',
            approvalStatus: 'approved',
          },
          record: {
            artifactId: 'script-e2e',
            artifactType: 'script',
            status: 'ready',
          },
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'script_agent',
        artifact: {
          artifactId: 'script-e2e',
          content: {
            title: 'Codex 入门第一课',
            hook: '如果你刚开始接触 Codex，先把目标说清楚。',
            body: '第一步，是告诉它你要做什么、项目在哪里、希望它先检查什么。',
            caption: '从一句清楚的目标开始，让 AI 帮你推进任务。',
            tags: ['#Codex', '#AI编程'],
            durationSeconds: 30,
            voiceNotes: '自然、清晰、稳定。',
            shotNotes: '正面半身数字人口播，字幕分句出现。',
            riskNotes: '',
          },
        },
      }),
    })
  })
}

async function mockIndexTTS2(page: Page) {
  await page.route('**/api/projects/*/audio/indextts2', async (route) => {
    const body = route.request().postDataJSON()
    expect(body.parameters.scriptArtifactId).toBe('script-e2e')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'indextts2_service',
        artifact: {
          artifactId: 'audio-e2e',
          artifactType: 'audio',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: body.sessionId,
          status: 'ready',
          source: 'indextts2',
          outputPath: 'artifacts/audio/audio-e2e.wav',
          durationSeconds: 8.2,
          parameters: body.parameters,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockHeyGem(page: Page) {
  await page.route('**/api/projects/*/digital-human/heygem', async (route) => {
    const body = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'heygem_service',
        artifact: {
          artifactId: 'render-e2e',
          artifactType: 'render',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: body.sessionId,
          status: 'ready',
          source: 'heygem',
          scriptArtifactId: 'script-e2e',
          audioArtifactId: 'audio-e2e',
          outputPath: 'artifacts/render/render-e2e.mp4',
          durationSeconds: 8.2,
          avatar: body.input.avatar,
          mode: body.input.mode,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockHeyGemError(page: Page) {
  await page.route('**/api/projects/*/digital-human/heygem', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'adapter_error',
        source: 'heygem',
        error: {
          code: 'runtime_missing',
          message: 'HeyGem runtime/API 不可用，请检查本地服务、脚本路径或端口配置。',
        },
      }),
    })
  })
}

async function mockPostProductionAgent(page: Page) {
  await page.route('**/api/projects/*/post-production-agent', async (route) => {
    const body = route.request().postDataJSON()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'post_production_agent',
        skillCall: {
          skillId: 'builtin:post-production-cut-review',
          skillName: 'post-production-cut-review',
        },
        artifact: {
          artifactId: 'post-e2e',
          artifactType: 'post-production',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: body.sessionId,
          status: 'ready',
          source: 'local_ffmpeg',
          renderArtifactId: 'render-e2e',
          scriptArtifactId: 'script-e2e',
          outputPath: 'artifacts/post-production/post-e2e.mp4',
          subtitlePath: 'artifacts/post-production/post-e2e.srt',
          coverPath: 'artifacts/post-production/post-e2e.png',
          durationSeconds: 8.2,
          parameters: { plan: body.input.plan, request: body.input.request },
          skillCall: {
            skillId: 'builtin:post-production-cut-review',
            skillName: 'post-production-cut-review',
          },
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockPublishAgent(page: Page) {
  await page.route('**/api/projects/*/publish-agent', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'manual_required',
          source: 'visible_browser',
          supportedPlatforms: ['douyin', 'xiaohongshu'],
          message: '发布包准备完成后，由用户监督浏览器登录与最终提交。',
        }),
      })
      return
    }

    const body = route.request().postDataJSON()
    expect(body.input.postProductionArtifactId).toBe('post-e2e')
    expect(body.input.platforms).toEqual(['douyin', 'xiaohongshu'])
    const platform = (platformId: 'douyin' | 'xiaohongshu', platformName: string, publishPageUrl: string) => ({
      platformId,
      platformName,
      browserStatus: 'manual_required',
      publishPageUrl,
      title: body.input.title,
      description: body.input.description,
      tags: body.input.tags,
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        source: 'local_publish_package',
        nextStep: 'manual_browser_required',
        artifact: {
          artifactId: 'publish-e2e',
          artifactType: 'publish-package',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: body.sessionId,
          status: 'ready',
          source: 'local_publish_package',
          postProductionArtifactId: 'post-e2e',
          scriptArtifactId: 'script-e2e',
          videoPath: 'artifacts/post-production/post-e2e.mp4',
          coverPath: 'artifacts/post-production/post-e2e.png',
          platforms: [
            platform('douyin', '抖音', 'https://creator.douyin.com/creator-micro/content/upload'),
            platform('xiaohongshu', '小红书', 'https://creator.xiaohongshu.com/publish/publish'),
          ],
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}
