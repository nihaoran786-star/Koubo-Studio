# 056 - 文案页 Provider 配置恢复提示

状态：Done

## What to build

当数字人文案页调用 `script-agent` 返回 `needs_configuration` 时，前端需要根据 `error.code` 显示明确、可执行的恢复提示，而不是笼统提示“检查后端或模型服务”。

## Why now

053 和 054 已经把默认模型 Provider 接入后端 Store、Settings API 和 Provider Resolution。文本页必须把 Provider、API Key、模型服务和本地后端配置失败清楚暴露给用户，帮助用户判断是后端运行环境不满足项目要求，还是需要去设置页补充 Provider 配置。

## Acceptance criteria

- [x] `needs_configuration` 支持区分：
  - `unsupported_node_version`
  - `no_default_provider`
  - `provider_disabled`
  - `missing_credentials`
  - `unsupported_provider`
  - `runtime_error`
- [x] 错误展示映射放在 `lib/agents`，页面组件只渲染展示模型。
- [x] 文案页右侧 AI 协同区域显示标题、详情和下一步操作。
- [x] 聊天消息保留后端错误码和错误信息，便于排查。
- [x] 单测覆盖 Node 版本和 Provider 凭据缺失。
- [x] E2E 覆盖 Provider 缺少 API Key 的恢复提示。

## Implementation notes

- 展示模型入口：`configurationNoticeFromScriptAgentResult`。
- UI 仍通过 `useScriptAgent(projectId)` 获取 `status` 和 `lastResult`。
- 页面组件不读取 Provider Store，也不判断 adapter、后端版本或 API Key 来源。

## Verification

```powershell
pnpm vitest run lib/agents/script-agent-client.test.ts
pnpm test:e2e -- tests/e2e/script-page.spec.ts --grep "needs-configuration"
pnpm typecheck
pnpm build
```
