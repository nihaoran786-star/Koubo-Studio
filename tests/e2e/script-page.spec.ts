import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const screenshotPath = path.join(process.cwd(), 'test-results', 'script-page-success.png')
const publishEvidenceScreenshotPath = path.join(process.cwd(), 'test-results', 'publish-evidence.png')
const loginToScriptScreenshotPath = path.join(process.cwd(), 'test-results', 'login-to-script-inline-generate.png')
const fixtureDir = path.join(process.cwd(), 'test-results', 'audio-fixtures')

test.afterEach(async () => {
  await fs.rm(screenshotPath, { force: true })
  await fs.rm(publishEvidenceScreenshotPath, { force: true })
  await fs.rm(loginToScriptScreenshotPath, { force: true })
  await fs.rm(fixtureDir, { recursive: true, force: true })
})

test('script page writes generated script to the left document area', async ({ page }) => {
  await page.route('**/api/projects/*/script-agent', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (route.request().postDataJSON().turnType === 'clarify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: '这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？',
          clarification: {
            readiness: 'needs_more_context',
            canGenerate: false,
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

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()

  await expect(page.getByRole('button', { name: '生成中…' })).toBeVisible()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await expect(page.getByText('如果你刚开始接触 Codex，先把目标说清楚。')).toBeVisible()
  await expect(page.getByText('第一步，是告诉它你要做什么、项目在哪里、希望它先检查什么。')).toBeVisible()
  await expect(page.getByText('从一句清楚的目标开始，让 AI 帮你推进任务。')).toBeVisible()
  await expect(page.getByRole('button', { name: '确认文案' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步' })).toBeHidden()

  await page.screenshot({ path: screenshotPath, fullPage: true })
  await expect.poll(async () => fs.stat(screenshotPath).then((stat) => stat.size)).toBeGreaterThan(0)
})

test('script page runs AI clarification turns before generating and approving script', async ({ page }) => {
  let clarifyCount = 0
  await page.route('**/api/projects/*/script-agent', async (route) => {
    const request = route.request()
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON()
      expect(body.artifactId).toBe('script-e2e')
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
        }),
      })
      return
    }

    const body = request.postDataJSON()
    if (body.turnType === 'clarify') {
      clarifyCount += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: clarifyCount === 1
            ? '这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？'
            : '信息已经够了，我可以开始写第一版文案。',
          clarification: {
            readiness: clarifyCount === 1 ? 'needs_more_context' : 'ready_to_generate',
            canGenerate: clarifyCount > 1,
          },
        }),
      })
      return
    }

    expect(body.turnType).toBe('generate_artifact')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(scriptAgentOkResponse()),
    })
  })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await expect(page.getByText('这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？')).toBeVisible()

  await page.getByPlaceholder('补充目标用户、语气或重点…').fill('给刚入门的新手，语气口语一点')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/可以点击“生成文案”/)).toBeVisible()

  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await approveScript(page)
  await expect(page.getByLabel('语速')).toBeVisible()
})

test('script page shows needs-configuration state from the backend', async ({ page }) => {
  await page.route('**/api/projects/*/script-agent', async (route) => {
    if (route.request().postDataJSON().turnType === 'clarify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: '这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？',
          clarification: {
            readiness: 'needs_more_context',
            canGenerate: false,
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'needs_configuration',
        source: 'script_agent',
        error: {
          code: 'missing_credentials',
          message: 'Provider「OpenAI API」需要 API Key。',
        },
      }),
    })
  })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()

  await expect(page.getByText('默认模型 Provider 缺少凭据')).toBeVisible()
  await expect(page.getByText('Provider「OpenAI API」需要 API Key。', { exact: true })).toBeVisible()
  await expect(page.getByText('请到顶部设置页补齐 API Key、Base URL 和模型名，再测试连接。')).toBeVisible()
  await expect(page.getByText(/需要先完成 AI 后端配置/)).toBeVisible()
})

test('create flow shows AI service readiness warning from desktop runtime requirements', async ({ page }) => {
  await page.route('**/api/projects/*/desktop-runtime', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'available',
        source: 'desktop_runtime',
        runtimeStatus: 'dev_server',
        capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
        requirements: [
          {
            id: 'node_runtime',
            capability: 'script_agent',
            status: 'blocked',
            requiredVersion: '22.19.0',
            actualVersion: '20.20.0',
            error: {
              code: 'unsupported_node_version',
              message: '本地后端需要 Node >= 22.19.0，当前是 20.20.0',
            },
          },
        ],
      }),
    })
  })

  await openScriptPage(page)

  await expect(page.getByText('AI 文案服务暂不可用：')).toBeVisible()
  await expect(page.getByText(/DESKTOP_BACKEND_NODE_PATH/)).toBeVisible()
})

test('create flow shows agent session timeline from the project API', async ({ page }) => {
  await mockAgentTimeline(page)

  await openScriptPage(page)
  await expect(page.getByText('生产链路')).toBeVisible()
  await expect(page.getByText(/文本智能体/)).toBeVisible()
  await page.getByRole('button', { name: '展开生产链路' }).click()

  await expect(page.getByText('声音工作流', { exact: true })).toBeVisible()
  await expect(page.getByText('数字人工作流', { exact: true })).toBeVisible()
  await expect(page.getByText('数字人视频 · ready')).toBeVisible()
})

test('script page shows parse error state from the backend', async ({ page }) => {
  await page.route('**/api/projects/*/script-agent', async (route) => {
    if (route.request().postDataJSON().turnType === 'clarify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: '这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？',
          clarification: {
            readiness: 'needs_more_context',
            canGenerate: false,
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'script_parse_error',
        source: 'script_agent',
        error: {
          code: 'script_parse_error',
          message: '模型回复 JSON 格式无效',
        },
      }),
    })
  })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()

  await expect(page.getByText('AI 回复没有形成可写入左侧的结构化文案，可以补充要求后重新生成。')).toBeVisible()
  await expect(page.getByText(/没有拿到可写入左侧的结构化文案/)).toBeVisible()
})

test('settings page loads model providers from API and saves provider config', async ({ page }) => {
  let savedBody: unknown
  let testedBody: unknown
  await page.route('**/api/settings/model-providers', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      testedBody = request.postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'model_provider_test',
          result: {
            status: 'connected',
            source: 'model_provider_test',
            providerId: 'openai',
            testedAt: '2026-06-11T00:00:00.000Z',
          },
          settings: modelProviderSettingsFixture({
            openai: {
              enabled: true,
              hasApiKey: true,
              apiKeyPreview: 'sk-t...cret',
              status: 'connected',
            },
          }),
        }),
      })
      return
    }

    if (request.method() === 'PUT') {
      savedBody = request.postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'model_provider_store',
          settings: modelProviderSettingsFixture({
            openai: {
              enabled: true,
              hasApiKey: true,
              apiKeyPreview: 'sk-t...cret',
              status: 'configured',
            },
          }),
        }),
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'model_provider_store',
        settings: modelProviderSettingsFixture(),
      }),
    })
  })

  await page.goto('/')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: '设置' }).click()

  await expect(page.getByText('OpenAI API', { exact: true })).toBeVisible()
  await expect(page.getByText('DeepSeek API', { exact: true })).toBeVisible()
  await page.getByLabel('API Key').first().fill('sk-test-secret')
  await page.getByLabel('保存').first().click()

  await expect.poll(() => savedBody).toMatchObject({
    providers: [
      {
        id: 'openai',
        apiKey: 'sk-test-secret',
      },
    ],
  })
  await page.getByLabel('测试连接').first().click()
  await expect.poll(() => testedBody).toEqual({ providerId: 'openai' })
  await expect(page.getByText('已连接')).toBeVisible()
})

test('login provider setup flows into script agent inline generation', async ({ page }) => {
  let savedBody: unknown
  let scriptAgentGenerateBody: { turnType?: string; message?: string } | undefined
  await mockRuntimeReadiness(page)
  await page.route('**/api/settings/model-providers', async (route) => {
    const request = route.request()
    if (request.method() === 'PUT') {
      savedBody = request.postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'model_provider_store',
          settings: {
            ...modelProviderSettingsFixture({
              openai: {
                enabled: true,
                hasApiKey: true,
                apiKeyPreview: 'sk-t...cret',
                status: 'configured',
              },
            }),
            defaultProviderId: 'openai',
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
        source: 'model_provider_store',
        settings: modelProviderSettingsFixture(),
      }),
    })
  })
  await page.route('**/api/projects/*/script-agent', async (route) => {
    const body = route.request().postDataJSON()
    if (body.turnType === 'clarify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: '信息已经够了，我可以开始写第一版文案。',
          clarification: {
            readiness: 'ready_to_generate',
            canGenerate: true,
          },
        }),
      })
      return
    }

    scriptAgentGenerateBody = body
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(scriptAgentOkResponse()),
    })
  })

  await page.goto('/login')
  await expect(page.getByRole('heading', { name: '登录与模型接入' })).toBeVisible()
  await expect(page.getByText('ChatGPT 订阅登录', { exact: true })).toBeVisible()
  await expect(page.getByText(/不能直接作为模型 API 凭据/)).toBeVisible()
  await page.getByLabel('API Key').first().fill('sk-test-secret')
  await page.getByLabel('保存').first().click()
  await expect.poll(() => savedBody).toMatchObject({
    providers: [
      {
        id: 'openai',
        apiKey: 'sk-test-secret',
      },
    ],
  })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '生成左侧文案' })).toBeVisible()
  await page.getByRole('button', { name: '生成左侧文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await expect.poll(() => scriptAgentGenerateBody?.turnType).toBe('generate_artifact')
  expect(scriptAgentGenerateBody?.message).toContain('视频主题：做一条 Codex 入门 30 秒口播')

  await page.screenshot({ path: loginToScriptScreenshotPath, fullPage: true })
  await expect.poll(async () => fs.stat(loginToScriptScreenshotPath).then((stat) => stat.size)).toBeGreaterThan(0)
})

test('voice page submits IndexTTS2 parameters and shows generated audio state', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockIndexTTS2(page, { expectedReferencePath: 'files/audio/reference-e2e.wav', expectedTrimSeconds: 10 })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await expect(page.getByLabel('语速')).toBeVisible()
  await uploadVoiceReference(page)
  await page.getByLabel('语速').fill('1.25')
  await page.getByLabel('情绪强度').fill('0.35')
  await page.getByLabel('情绪提示').fill('自然、清晰、稳定，略带热情')
  await page.getByLabel('10 秒测试音频').check()
  await page.getByRole('button', { name: '生成音频' }).click()

  await expect(page.getByText('音频 audio-e2e')).toBeVisible()
  await expect(page.locator('audio[aria-label="试听生成音频"]')).toBeVisible()
  await expect(page.getByText('时长 8.2 秒')).toBeVisible()
  await expect(page.getByText('情绪 35%')).toBeVisible()
})

test('voice page shows IndexTTS2 runtime missing state', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await page.route('**/api/projects/*/audio/indextts2', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'adapter_error',
        source: 'indextts2',
        error: {
          code: 'runtime_missing',
          message: 'IndexTTS2 runtime 尚未配置。请设置 INDEXTTS2_RUNTIME_ROOT。',
        },
      }),
    })
  })

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()

  await expect(page.getByText('IndexTTS2 运行环境未就绪，请先完成本地模型配置。')).toBeVisible()
})

test('voice page uploads reference assets before submitting IndexTTS2 generation', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockIndexTTS2(page, {
    expectedReferencePath: 'files/audio/reference-e2e.wav',
    expectedEmotionPath: 'files/audio/emotion-e2e.wav',
  })
  const referenceFile = await createAudioFixture('reference.wav')
  const emotionFile = await createAudioFixture('emotion.wav')

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await page.getByRole('button', { name: '上传音频' }).click()
  await page.getByLabel('上传声音参考音频').setInputFiles(referenceFile)
  await expect(page.getByText('参考音频：reference.wav')).toBeVisible()
  await page.getByLabel('上传情绪参考音频').setInputFiles(emotionFile)
  await expect(page.getByText('情绪参考：emotion.wav')).toBeVisible()
  await page.getByRole('button', { name: '生成音频' }).click()

  await expect(page.getByText('音频 audio-e2e')).toBeVisible()
})

test('voice page restores latest ready audio artifact', async ({ page }) => {
  await mockScriptAgent(page)
  await mockLatestAudioArtifact(page)

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()
  await approveScript(page)

  await expect(page.getByText('音频 restored-audio')).toBeVisible()
  await expect(page.getByText('时长 6.4 秒')).toBeVisible()
  await expect(page.locator('audio[aria-label="试听生成音频"]')).toBeVisible()
})

test('avatar page submits only the selected avatar id to HeyGem generation', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUpload(page)
  await mockIndexTTS2(page)
  await mockHeyGem(page)

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('请上传正脸视频形象后生成数字人。')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成' })).toBeDisabled()
  await uploadAvatarVideo(page)
  await page.getByRole('button', { name: '生成' }).click()

  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeVisible()
})

test('avatar page shows HeyGem adapter error without fake success', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUpload(page)
  await mockIndexTTS2(page)
  await mockHeyGemError(page)

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await uploadAvatarVideo(page)
  await page.getByRole('button', { name: '生成' }).click()

  await expect(page.getByText('HeyGem runtime/API 不可用，请检查本地服务、脚本路径或端口配置。')).toBeVisible()
  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeHidden()
})

test('avatar page uploads avatar asset before HeyGem generation', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockIndexTTS2(page)
  await mockAvatarAssetUpload(page)
  await mockHeyGemUpload(page)
  const avatarFile = await createVideoFixture('avatar.mp4')

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByLabel('上传数字人形象视频').setInputFiles(avatarFile)
  await expect(page.getByText('avatar.mp4')).toBeVisible()
  await page.getByRole('button', { name: '生成' }).click()

  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeVisible()
})

test('render page runs post-production agent and shows skill call result', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUpload(page)
  await mockIndexTTS2(page)
  await mockHeyGem(page)
  await mockPostProductionAgent(page)

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await expect(page.getByText('Codex 入门第一课')).toBeVisible()

  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await expect(page.getByText('音频 audio-e2e')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await uploadAvatarVideo(page)
  await page.getByRole('button', { name: '生成' }).click()
  await expect(page.getByText('数字人已生成 · 口型与表情已就绪')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('后期智能体会基于数字人视频、文案和当前样式生成成片。')).toBeVisible()
  await page.getByRole('button', { name: '导出成片' }).click()

  await expect(page.getByText('Skill 调用 · post-production-cut-review')).toBeVisible()
  await expect(page.getByText('已生成后期成片 artifact：post-e2e')).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步' })).toBeVisible()
})

test('publish page prepares a local package for Douyin and Xiaohongshu with manual final confirmation', async ({ page }) => {
  await mockScriptAgent(page)
  await mockAudioAssetUploads(page)
  await mockAvatarAssetUpload(page)
  await mockIndexTTS2(page)
  await mockHeyGem(page)
  await mockPostProductionAgent(page)
  await mockPublishAgent(page)

  await openScriptPage(page)
  await page.getByPlaceholder('例如：做一条介绍 Codex 入门的 30 秒口播视频').fill('做一条 Codex 入门 30 秒口播')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '生成文案' }).click()
  await approveScript(page)
  await uploadVoiceReference(page)
  await page.getByRole('button', { name: '生成音频' }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await uploadAvatarVideo(page)
  await page.getByRole('button', { name: '生成' }).click()
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '导出成片' }).click()
  await expect(page.getByText('已生成后期成片 artifact：post-e2e')).toBeVisible()

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByText('这里只生成本地发布包。浏览器登录、验证码和最终发布均由你监督并确认。')).toBeVisible()
  await expect(page.getByText('抖音')).toBeVisible()
  await expect(page.getByText('小红书')).toBeVisible()
  await page.getByRole('button', { name: '准备发布包' }).click()

  await expect(page.getByText('发布包已准备')).toBeVisible()
  await expect(page.getByText(/post-e2e\.mp4/)).toBeVisible()
  await expect(page.getByRole('link', { name: '抖音发布页' })).toHaveAttribute('href', 'https://creator.douyin.com/creator-micro/content/upload')
  await expect(page.getByRole('link', { name: '小红书发布页' })).toHaveAttribute('href', 'https://creator.xiaohongshu.com/publish/publish')
  await expect(page.getByText('当前只打开官方发布页，不会读取密码、绕过验证或自动点击最终发布。')).toBeVisible()
  await page.screenshot({ path: publishEvidenceScreenshotPath, fullPage: true })
  await expect.poll(async () => fs.stat(publishEvidenceScreenshotPath).then((stat) => stat.size)).toBeGreaterThan(0)
})

async function openScriptPage(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: /数字人视频/ }).click()
}

async function approveScript(page: import('@playwright/test').Page) {
  await expect(page.getByRole('button', { name: '确认文案' })).toBeVisible()
  await expect(page.getByRole('button', { name: '下一步' })).toBeHidden()
  await page.getByRole('button', { name: '确认文案' }).click()
  await expect(page.getByRole('button', { name: '已确认文案' })).toBeVisible()
  await page.getByRole('button', { name: '下一步' }).click()
}

async function uploadVoiceReference(page: import('@playwright/test').Page) {
  const referenceFile = await createAudioFixture('reference.wav')
  const uploadMode = page.getByRole('button', { name: '上传音频' })
  if (await uploadMode.isVisible()) {
    await uploadMode.click()
  }
  await page.getByLabel('上传声音参考音频').setInputFiles(referenceFile)
  await expect(page.getByText('参考音频：reference.wav')).toBeVisible()
}

async function uploadAvatarVideo(page: import('@playwright/test').Page) {
  const avatarFile = await createVideoFixture('avatar.mp4')
  await page.getByLabel('上传数字人形象视频').setInputFiles(avatarFile)
  await expect(page.getByText('avatar.mp4')).toBeVisible()
}

function scriptAgentOkResponse() {
  return {
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
  }
}

async function mockScriptAgent(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/script-agent', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      expect(body.artifactId).toBe('script-e2e')
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

    if (route.request().postDataJSON().turnType === 'clarify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          source: 'script_agent',
          turnType: 'clarify',
          reply: '这条视频主要想给刚入门的新手看，还是给已有经验的创作者看？',
          clarification: {
            readiness: 'needs_more_context',
            canGenerate: false,
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

async function mockRuntimeReadiness(page: import('@playwright/test').Page) {
  await page.route('**/api/settings/runtime-readiness', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ready',
        source: 'runtime_readiness',
        profile: {
          id: 'base',
          title: '基础版',
          description: '只要求主 App、AI 文案 Provider、workspace 和运行环境提示可用。',
          requiredCheckIds: ['model_provider'],
        },
        updatedAt: '2026-06-12T00:00:00.000Z',
        summary: { ready: 1, missing: 0, warning: 0 },
        checks: [
          {
            id: 'model_provider',
            title: 'AI 文案 Provider',
            status: 'ready',
            requiredForCurrentProfile: true,
            optionalForCurrentProfile: false,
            gaps: [],
            nextStep: '打开设置并测试默认 Provider。',
            provisioning: {
              priority: 1,
              stage: '文本智能体 Provider',
              required: ['OpenAI-compatible API endpoint'],
              sensitiveEnvKeys: ['OPENAI_API_KEY'],
              safeEvidence: '只保留脱敏 Provider 状态。',
            },
            remediation: {
              envKeys: [],
              envTemplate: '# 设置页配置',
              command: '打开设置并测试连接',
              docPath: 'docs/RUNTIME_PROVISIONING.md#推荐顺序',
            },
          },
        ],
      }),
    })
  })
}

async function mockAgentTimeline(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/agent?view=timeline', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'agent_session_timeline',
        projectId: 'demo',
        items: [
          {
            session: {
              sessionId: 'avatar-session-001',
              sessionKind: 'main',
              workspaceId: 'workspace-demo',
              workspacePath: 'C:/workspace/demo',
              backend: 'local',
              agentRole: 'digital_human',
              artifactId: 'render-e2e',
            },
            artifactRecord: {
              artifactId: 'render-e2e',
              artifactType: 'render',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'avatar-session-001',
              agentRole: 'digital_human',
              status: 'ready',
              path: 'C:/workspace/demo/artifacts/render/render-e2e.mp4',
              createdAt: '2026-06-11T03:00:00.000Z',
              updatedAt: '2026-06-11T03:00:00.000Z',
            },
          },
          {
            session: {
              sessionId: 'voice-session-001',
              sessionKind: 'main',
              workspaceId: 'workspace-demo',
              workspacePath: 'C:/workspace/demo',
              backend: 'local',
              agentRole: 'voice',
              artifactId: 'audio-e2e',
            },
            artifactRecord: {
              artifactId: 'audio-e2e',
              artifactType: 'audio',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'voice-session-001',
              agentRole: 'voice',
              status: 'ready',
              path: 'C:/workspace/demo/artifacts/audio/audio-e2e.wav',
              createdAt: '2026-06-11T02:00:00.000Z',
              updatedAt: '2026-06-11T02:00:00.000Z',
            },
          },
          {
            session: {
              sessionId: 'script-session-001',
              sessionKind: 'main',
              workspaceId: 'workspace-demo',
              workspacePath: 'C:/workspace/demo',
              backend: 'local',
              agentRole: 'script',
              artifactId: 'script-e2e',
            },
            artifactRecord: {
              artifactId: 'script-e2e',
              artifactType: 'script',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'script-session-001',
              agentRole: 'script',
              status: 'ready',
              path: 'C:/workspace/demo/artifacts/script/script-e2e.json',
              createdAt: '2026-06-11T01:00:00.000Z',
              updatedAt: '2026-06-11T01:00:00.000Z',
            },
          },
        ],
      }),
    })
  })
}

function modelProviderSettingsFixture(overrides: {
  openai?: Partial<{
    enabled: boolean
    hasApiKey: boolean
    apiKeyPreview: string
    status: string
  }>
} = {}) {
  return {
    defaultProviderId: 'local_openai_compatible',
    telemetryEnabled: false,
    providers: [
      {
        id: 'openai',
        kind: 'openai',
        name: 'OpenAI API',
        enabled: false,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        status: 'disabled',
        hasApiKey: false,
        apiKeyPreview: '',
        authMode: 'api_key',
        requiresApiKey: true,
        dataLocation: 'cloud_provider',
        note: '使用 OpenAI API Key。ChatGPT 订阅登录不等同于 API 凭据。',
        ...overrides.openai,
      },
      {
        id: 'deepseek',
        kind: 'deepseek',
        name: 'DeepSeek API',
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        status: 'disabled',
        hasApiKey: false,
        apiKeyPreview: '',
        authMode: 'api_key',
        requiresApiKey: true,
        dataLocation: 'cloud_provider',
        note: '使用 DeepSeek API Key，接口按 OpenAI-compatible 方式测试。',
      },
      {
        id: 'local_openai_compatible',
        kind: 'local_openai_compatible',
        name: '本地 OpenAI-compatible',
        enabled: true,
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5',
        status: 'configured',
        hasApiKey: false,
        apiKeyPreview: '',
        authMode: 'none',
        requiresApiKey: false,
        dataLocation: 'local_only',
        note: '适合本地兼容服务。',
      },
      {
        id: 'custom_openai_compatible',
        kind: 'custom_openai_compatible',
        name: '自定义 OpenAI-compatible',
        enabled: false,
        baseUrl: '',
        model: '',
        status: 'disabled',
        hasApiKey: false,
        apiKeyPreview: '',
        authMode: 'api_key',
        requiresApiKey: false,
        dataLocation: 'custom_endpoint',
        note: '适合私有网关或第三方兼容接口。',
      },
    ],
  }
}

async function mockIndexTTS2(
  page: import('@playwright/test').Page,
  options: { expectedReferencePath?: string; expectedEmotionPath?: string; expectedTrimSeconds?: number } = {},
) {
  await page.route('**/api/projects/*/audio/indextts2', async (route) => {
    const body = route.request().postDataJSON()
    expect(body.parameters.scriptArtifactId).toBe('script-e2e')
    if (options.expectedReferencePath) {
      expect(body.parameters.referenceAudioPath).toBe(options.expectedReferencePath)
    }
    if (options.expectedEmotionPath) {
      expect(body.parameters.emotionReferenceAudioPath).toBe(options.expectedEmotionPath)
    }
    if (typeof options.expectedTrimSeconds === 'number') {
      expect(body.parameters.trimSeconds).toBe(options.expectedTrimSeconds)
    }
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

async function mockHeyGem(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/digital-human/heygem', async (route) => {
    const body = route.request().postDataJSON()
    expect(body.sessionId).toBe('avatar-session')
    expect(body.input).toEqual({ avatarAssetId: 'avatar-e2e', mode: 'standard' })
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
          avatar: { source: 'upload', id: 'avatar-e2e', name: 'avatar.mp4', assetPath: 'files/avatar/avatar-e2e.mp4' },
          mode: body.input.mode,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockHeyGemError(page: import('@playwright/test').Page) {
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

async function mockAvatarAssetUpload(page: import('@playwright/test').Page) {
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
          relativePath: 'files/avatar/avatar-e2e.mp4',
          path: 'C:/workspace/files/avatar/avatar-e2e.mp4',
          size: 16,
          status: 'ready',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockHeyGemUpload(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/digital-human/heygem', async (route) => {
    const body = route.request().postDataJSON()
    expect(body.input).toEqual({ avatarAssetId: 'avatar-e2e', mode: 'standard' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'heygem_service',
        artifact: {
          artifactId: 'render-upload-e2e',
          artifactType: 'render',
          projectId: 'demo',
          featureType: 'digital-human',
          sessionId: body.sessionId,
          status: 'ready',
          source: 'heygem',
          scriptArtifactId: 'script-e2e',
          audioArtifactId: 'audio-e2e',
          outputPath: 'artifacts/render/render-upload-e2e.mp4',
          durationSeconds: 8.2,
          avatar: { source: 'upload', id: 'avatar-e2e', name: 'avatar.mp4', assetPath: 'files/avatar/avatar-e2e.mp4' },
          mode: body.input.mode,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockPostProductionAgent(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/post-production-agent', async (route) => {
    const body = route.request().postDataJSON()
    expect(body.sessionId).toBe('post-session')
    expect(body.input.renderArtifactId).toBe('render-e2e')
    expect(body.input.request).toBe('加字幕并整理成片')
    expect(body.input.skill).toBeUndefined()
    expect(body.input.plan).toMatchObject({ version: 1, ratio: '9:16' })
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

async function mockPublishAgent(page: import('@playwright/test').Page) {
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
    expect(body.sessionId).toMatch(/^publish-/)
    expect(body.input.postProductionArtifactId).toBe('post-e2e')
    expect(body.input.platforms).toEqual(['douyin', 'xiaohongshu'])
    expect(body.input.title).toBe('Codex 入门第一课')
    expect(body.input.description).toBe('从一句清楚的目标开始，让 AI 帮你推进任务。')
    expect(body.input.tags).toEqual(['#Codex', '#AI编程'])

    const now = '2026-06-11T00:00:00.000Z'
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
            {
              platformId: 'douyin',
              platformName: '抖音',
              browserStatus: 'manual_required',
              publishPageUrl: 'https://creator.douyin.com/creator-micro/content/upload',
              title: body.input.title,
              description: body.input.description,
              tags: body.input.tags,
            },
            {
              platformId: 'xiaohongshu',
              platformName: '小红书',
              browserStatus: 'manual_required',
              publishPageUrl: 'https://creator.xiaohongshu.com/publish/publish',
              title: body.input.title,
              description: body.input.description,
              tags: body.input.tags,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      }),
    })
  })
}

async function mockAudioAssetUploads(page: import('@playwright/test').Page) {
  let count = 0
  await page.route('**/api/projects/*/audio-assets', async (route) => {
    count += 1
    const isReference = count === 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'audio_asset',
        asset: {
          assetId: isReference ? 'reference-e2e' : 'emotion-e2e',
          assetType: 'audio',
          projectId: 'demo',
          featureType: 'digital-human',
          purpose: isReference ? 'reference' : 'emotion',
          originalFilename: isReference ? 'reference.wav' : 'emotion.wav',
          contentType: 'audio/wav',
          relativePath: isReference ? 'files/audio/reference-e2e.wav' : 'files/audio/emotion-e2e.wav',
          path: isReference
            ? 'C:/workspace/files/audio/reference-e2e.wav'
            : 'C:/workspace/files/audio/emotion-e2e.wav',
          size: 16,
          status: 'ready',
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    })
  })
}

async function mockLatestAudioArtifact(page: import('@playwright/test').Page) {
  await page.route('**/api/projects/*/audio-artifacts/latest', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        source: 'audio_artifact_query',
        selected: {
          artifactId: 'restored-audio',
          outputPath: 'C:/workspace/artifacts/audio/restored-audio.wav',
          durationSeconds: 6.4,
          playbackUrl: '/api/projects/demo/audio-artifacts/restored-audio/file',
          createdAt: '2026-06-11T00:00:00.000Z',
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
