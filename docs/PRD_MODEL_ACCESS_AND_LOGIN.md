# 口播智能体模型接入与登录体系 PRD

更新时间：2026-07-17

## Problem Statement

本 PRD 最初用于解决模型接入、登录状态、API Key 配置、连接测试、默认模型选择和数据流向混杂的问题。当前实现已将模型接入收敛到后端 Provider Store、Provider Resolution 和原生 OpenAI-compatible adapter，设置页不再以浏览器本地状态作为凭据事实源。

产品需要支持 OpenAI、DeepSeek、本地模型、自定义 OpenAI-compatible endpoint，以及未来可能的账号登录方式。问题在于“登录”和“模型接入”如果混在一个 `/login` 概念里，会把用户身份、API Key、ChatGPT 订阅、API 平台计费、文案上下文、项目 workspace 和桌面端安全存储耦合在一起。

本 PRD 的目标是定义一套可扩展的“接入中心”：既能覆盖全部接入蓝图，又能让第一阶段以可验证、可迭代的方式落地。

## Solution

建立一个统一的“接入中心”，但内部拆成五层：

1. 账号身份层：管理当前应用用户或本地 profile，不直接等同于模型服务授权。
2. 模型 Provider 层：管理 OpenAI API、DeepSeek API、本地模型、自定义 OpenAI-compatible 等模型服务。
3. 凭据层：管理 API Key、base URL、模型名、组织信息和测试结果。
4. Script Agent 编排层：通过 Provider Resolution 获取配置，并由原生 OpenAI-compatible adapter 执行文案协作请求。
5. 桌面运行层：在 Tauri 桌面端决定凭据存储、后端承载方式和本地服务健康检查。

第一版不把 ChatGPT Plus / Pro / Business 订阅当成可直接调用 API 的 Provider。根据 OpenAI 官方帮助文档，ChatGPT 订阅和 API 平台计费是分开的，ChatGPT Plus 不包含 API usage。OpenAI 订阅登录可以作为未来“账号身份”或“跳转引导”能力，但不能被设计成可直接驱动后端生成的模型凭据。

第一阶段让设置页真实映射到后端 Provider 配置，并支持连接测试、默认 Provider 选择、错误状态展示和数据流向说明。第二阶段让文案页调用 Script Agent，并通过 Provider Resolution 使用默认 Provider。第三阶段再扩展账号登录、OAuth、团队配置、密钥迁移和桌面安全存储。

## User Stories

1. As a 内容创作者, I want to configure an OpenAI API Key, so that the app can use OpenAI models for script generation.
2. As a 内容创作者, I want to configure a DeepSeek API Key, so that I can use a lower-cost or preferred Chinese-friendly model provider.
3. As a 内容创作者, I want to configure a local OpenAI-compatible endpoint, so that drafts can stay on my machine when possible.
4. As a 内容创作者, I want to configure a custom OpenAI-compatible endpoint, so that I can use private gateways or third-party model services.
5. As a 内容创作者, I want to see which Provider is the default, so that I know where AI requests will be sent.
6. As a 内容创作者, I want to test a Provider connection before using it, so that I can fix API Key, base URL, or model errors early.
7. As a 内容创作者, I want failed connection tests to show a clear reason, so that I know whether the problem is network, credentials, model name, quota, or provider compatibility.
8. As a 内容创作者, I want the settings page to explain whether data leaves my computer, so that I can make privacy decisions before sending scripts to cloud models.
9. As a 内容创作者, I want the app to warn me when the model service or local backend is not ready, so that I understand why AI generation cannot run.
10. As a 内容创作者, I want the app to distinguish ChatGPT subscription login from API access, so that I am not misled into thinking my ChatGPT Plus subscription can automatically pay for API calls.
11. As a 内容创作者, I want the app to guide me to use an API Key when a Provider requires one, so that setup stays practical.
12. As a 内容创作者, I want local profile data and model credentials to be separate, so that changing a model key does not affect my project history.
13. As a 内容创作者, I want workspace data to remain isolated by project and feature, so that one video task does not pollute another.
14. As a 内容创作者, I want script versions, artifacts, and stage state to persist per project, so that I can continue a digital-human script conversation later.
15. As a 内容创作者, I want Provider status to be explicit, so that the UI does not infer configuration from empty arrays or vague strings.
16. As a 内容创作者, I want disabled Providers to remain saved but unused, so that I can switch providers later without retyping everything.
17. As a 内容创作者, I want the default Provider to fail gracefully, so that a broken cloud key does not destroy local project data.
18. As a 内容创作者, I want the app to support future OAuth-style login where officially available, so that enterprise or team workflows can be added later.
19. As a 技术配置用户, I want Provider adapters to be modular, so that adding another model provider does not require rewriting Script Agent or UI code.
20. As a 技术配置用户, I want API routes to return stable status, source, and error codes, so that the frontend can show correct recovery actions.
21. As a 技术配置用户, I want secrets to avoid being stored casually in browser localStorage in the final desktop product, so that credentials are not leaked.
22. As a 技术配置用户, I want local development to work before desktop packaging, so that backend behavior can be verified with `pnpm dev` and `pnpm build`.
23. As a 桌面端用户, I want the app to tell me whether the local backend is running, so that I can distinguish UI bugs from backend startup failures.
24. As a 桌面端用户, I want credentials to stay on my device unless I intentionally use a cloud Provider, so that desktop privacy expectations are respected.
25. As a 后续开发者, I want the PRD to separate identity, credentials, Provider adapters, Script Agent orchestration, and workspace storage, so that each module can be implemented and tested independently.

## Implementation Decisions

- Keep Script Agent as the AI task orchestration boundary; it does not own login or credential concepts.
- Treat “login” and “model access” as separate domains:
  - Login identifies the current app user or local profile.
  - Model access authorizes requests to a model service.
  - Workspace script versions, artifacts, and explicit stage state track project-level AI collaboration context.
- Do not implement “ChatGPT subscription as API Provider” because ChatGPT subscription billing is separate from API platform billing.
- Support these Provider families in the access model:
  - OpenAI API Key.
  - DeepSeek API Key.
  - Local OpenAI-compatible endpoint.
  - Custom OpenAI-compatible endpoint.
  - Future official OAuth or account-link flows where the provider supports them.
- Define a Provider Catalog module that lists supported provider types, required fields, default base URLs, supported auth modes, and data-location notes.
- Define a Provider Store module that persists user-selected provider settings and separates public config from secrets.
- Define a Credentials module that owns API Key storage and redaction. In early development it may use local app storage, but the desktop target should move secrets to an OS-backed or Tauri-supported secure storage mechanism.
- Define a Provider Test Service that verifies credentials with a minimal request and returns normalized status.
- Define Provider Adapters for OpenAI, DeepSeek, local OpenAI-compatible endpoints, and custom OpenAI-compatible endpoints.
- Define a Provider Resolution Service that decides which configured Provider should be used for a given feature, task, or project.
- Script Agent Service must accept Provider Resolution output instead of reading settings UI state directly.
- API routes must stay thin: validate request, call module interface, return normalized response.
- UI must not directly access model adapters, filesystem paths, backend runtime details, workspace files, or raw credential storage.
- Settings UI should render the normalized access state and submit user actions through hooks or client modules.
- Project workspaces remain isolated by project ID and feature type.
- Provider configuration is global or profile-level by default; project-level override can be added later if needed.
- Provider statuses must be explicit:
  - `disabled`
  - `missing_credentials`
  - `configured`
  - `testing`
  - `connected`
  - `auth_error`
  - `network_error`
  - `model_error`
  - `quota_error`
  - `runtime_error`
- Agent call statuses must remain explicit:
  - `ok`
  - `invalid_request`
  - `needs_configuration`
  - `provider_error`
  - `agent_error`
  - `runtime_unavailable`
- Error responses must include stable `status`, `source`, `error.code`, and user-facing `error.message`.
- The setup experience should distinguish these states:
  - no Provider configured
  - Provider configured but not tested
  - Provider connected
  - Provider failed
  - model service unavailable
  - backend runtime unsupported
  - desktop backend unavailable
- The settings page should show a concise data-flow label for each Provider:
  - local only
  - sends text to configured endpoint
  - sends text to cloud provider
  - custom endpoint, user responsible for data policy
- The first implementation slice should not attempt to solve every future auth mode. It should build the interfaces so future auth modes can be added without changing UI assumptions.
- The desktop packaging strategy remains a blocking architectural decision for production use because static export cannot host Next API routes.

## Testing Decisions

- Tests should verify module behavior through public interfaces, not implementation details.
- Provider Catalog tests should verify required fields, default labels, base URLs, and data-location notes for each Provider family.
- Provider validation tests should verify empty keys, invalid URLs, missing model names, disabled providers, and unsupported provider types.
- Provider Test Service tests should verify normalized responses for success, auth failure, network failure, model-not-found, quota failure, and provider-specific errors.
- Provider Resolution tests should verify default Provider selection, disabled Provider exclusion, fallback behavior, and missing-configuration responses.
- API route tests should verify stable response shapes for invalid request, missing configuration, connected Provider, provider error, and runtime unavailable.
- Script Agent integration tests should verify that the native OpenAI-compatible adapter receives resolved Provider config through an interface, not through UI state or raw localStorage.
- Settings UI tests should verify visible behavior:
  - provider list renders
  - fields are editable
  - secrets are redacted after save
  - test status changes correctly
  - default Provider can be selected
  - data-flow warnings are visible
- Desktop security verification should check that final credential storage does not rely on browser localStorage for API Keys.
- Build verification should continue to include `pnpm lint` and `pnpm build`.
- Manual verification should include one OpenAI API Key provider, one DeepSeek provider, one local OpenAI-compatible provider, and one failing custom endpoint.

## Out of Scope

- Building a full SaaS account system in the first implementation slice.
- Treating ChatGPT Plus, Pro, or Business subscription as an API credential.
- Scraping or automating ChatGPT web login.
- Automatic platform publishing to Douyin, Xiaohongshu, Video Account, or other video platforms.
- Payment, billing, team seats, invoices, or usage metering beyond basic Provider status.
- Migrating all project data from localStorage to durable workspace storage in the same slice.
- Implementing every possible LLM vendor before the adapter interfaces are stable.
- Shipping production desktop credential storage before the desktop backend strategy is decided.

## Further Notes

The right product language is not “全部登录方式都塞进 `/login`”，而是“接入中心”。`/login` 可以存在，但它只应该处理应用账号身份。模型服务接入应走 Provider 配置和授权状态。

Recommended rollout:

1. Access Model PRD and architecture alignment.
2. Provider Catalog, Store, Credentials, Test Service, and normalized status contracts. 已开始落地，见 Issue 053。
3. Settings page mapped to backend Provider APIs.
4. Script Agent uses the resolved default Provider.
5. Digital-human script page calls Script Agent and handles `needs_configuration` / `provider_error`.
6. Desktop backend strategy and secure credential storage.
7. Future account login or OAuth-style provider linking where officially supported.

## Current Implementation Status

- Issue 053 已新增后端 Provider Catalog、Provider Store、Provider Test Service 和 `/api/settings/model-providers`。
- 当前 GET 已返回脱敏公开设置，API Key 只在后端 store 中保留，不通过 API 明文回传。
- 当前 POST test 会用 OpenAI-compatible `/models` endpoint 做最小连接测试，并返回稳定状态码。
- Settings UI 已接入该 API，旧 `lib/workspace.ts` 中的 provider localStorage 状态不能作为最终凭据来源。
- Settings UI 已显示每个 Provider 的接入方式：API Key 必填、API Key 可选或无需密钥，并在设置页明确提示 ChatGPT 订阅登录属于账号身份能力，不等同于模型 API 调用凭据。
- Script Agent Service 已接入 Provider Resolution，不直接读取 Settings UI 状态；原生 OpenAI-compatible adapter 使用解析后的 base URL、模型与凭据发起请求。
- 文案上下文由 workspace 内的文案版本、artifact 与项目阶段状态持久化；不依赖外部 Agent SDK 的持久 session。
- 真实 Provider → Script Agent → 文案 artifact 链路使用 `pnpm smoke:model-provider` 验证；桌面后端的 Node `>= 22.19.0` 是项目级运行要求。

External facts checked while drafting:

- OpenAI Help Center states ChatGPT Plus does not include API usage; API usage is billed separately.
- OpenAI Help Center states ChatGPT web billing and API Platform billing are separate systems.
- DeepSeek API docs state DeepSeek API uses bearer API key authentication and is compatible with OpenAI/Anthropic-style API formats.
