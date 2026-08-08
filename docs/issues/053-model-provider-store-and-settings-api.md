# 053 - 模型 Provider Store 与 Settings API

状态：Done

## What to build

把设置页背后的模型接入从浏览器本地状态推进到后端接入中心：建立 Provider Catalog、Provider Store、凭据脱敏、连接测试服务和 `/api/settings/model-providers` API。第一批支持 OpenAI API、DeepSeek API、本地 OpenAI-compatible、自定义 OpenAI-compatible。

## Why now

文本智能体真实 AI 能力、Provider Resolution、DeepSeek/OpenAI 接入和桌面端凭据安全都依赖统一 Provider 状态。如果继续让设置页直接持有 API Key 和连接判断，会把 UI、Script Agent、凭据、登录和 workspace 混在一起。

## Acceptance criteria

- [x] 有 Provider Catalog，列出 OpenAI、DeepSeek、本地 OpenAI-compatible、自定义 OpenAI-compatible。
- [x] 有后端 Provider Store，能读取默认配置并持久化用户配置。
- [x] API Key 不通过 GET 明文返回；公开设置只返回 `hasApiKey` 和 `apiKeyPreview`。
- [x] 有 Provider Test Service，能把连接测试归一化为 `connected`、`missing_credentials`、`auth_error`、`network_error`、`model_error`、`quota_error`、`runtime_error`。
- [x] 新增 `/api/settings/model-providers`，支持 GET、PUT、POST test。
- [x] Settings 页面改为通过 API 读写 Provider 设置，不再把 API Key 存入 browser localStorage。
- [x] Script Agent 使用默认 Provider 的工作曾拆到 Issue 054；当前由 Provider Resolution 向原生 OpenAI-compatible adapter 提供配置，避免与 Settings UI/API 混在同一切片。
- [x] E2E 覆盖设置页 Provider 配置和连接测试反馈。

## Current implementation notes

- `lib/model-providers/model-provider-catalog.ts` 定义 Provider 家族、默认 base URL、默认模型、认证方式和数据流向。
- `lib/model-providers/model-provider-store.ts` 使用 `data/settings/model-providers.json` 持久化配置；这是后端本地文件，不是浏览器 localStorage。
- `lib/model-providers/model-provider-test-service.ts` 使用 OpenAI-compatible `/models` endpoint 做最小连接测试。
- `lib/model-providers/model-provider-route-handler.ts` 为 API route 提供薄处理层。
- `app/api/settings/model-providers/route.ts` 暴露 GET/PUT/POST。
- `components/settings/settings-page.tsx` 已改为通过 `useModelProviderSettings` 读写后端 Settings API；API Key 输入框默认为空，只显示脱敏 placeholder，避免把脱敏值写回。
- Settings 页面已展示每个 Provider 的接入方式，区分 API Key 必填、API Key 可选和无需密钥，并提示 ChatGPT 订阅登录不等同于模型 API 凭据。
- `components/settings/settings-page.test.tsx` 覆盖从 API 加载 Provider、保存时调用 PUT、且不写 browser localStorage。
- `tests/e2e/script-page.spec.ts` 覆盖设置页加载 Provider、保存 OpenAI API Key 草稿到 Settings API，并显示连接测试成功状态。

## Follow-up issues to create after this slice

- Script Agent Provider Resolution：让文案 Agent 显式消费默认 Provider 配置。该项已由当前原生 adapter 链路完成。
- 桌面端安全凭据存储：从本地 JSON 文件迁移到 OS-backed secret store 或 Tauri 插件。

## Blocked by

- None.
