# Issue 034 - 文本 Agent API Route

## What to build

新增或改造后端 API route，让前端文案页通过稳定接口调用 Script Agent Service，而不是在 UI 中调用模型 adapter 或解析原始模型回复。

## User pain

当时已有文本 Agent Service 能把模型输出保存成 script artifact，但前端还没有稳定接口使用它。若文案页绕过 Script Agent route 直接调用模型，就会绕过 script artifact 持久化。

## Acceptance criteria

- [x] route 接收 `projectId`、`message`、`promptName`、`approvalStatus`。
- [x] route 校验 `message` 不能为空。
- [x] route 校验 `approvalStatus` 只能是 `draft` 或 `approved`。
- [x] route 调用 `runScriptAgent`，不直接调用原生 OpenAI-compatible adapter。
- [x] route 返回 `status/source/error` 标准格式。
- [x] `script_parse_error` 返回 422。
- [x] `needs_configuration` 返回 500 或后续约定的配置状态码，并保留错误 code。
- [x] 有 route 或服务边界测试覆盖成功、空 message、非法 approvalStatus、parse error。

## Progress

- 2026-06-11：新增 `POST /api/projects/:projectId/script-agent`。
- 2026-06-11：新增 `handleScriptAgentPost`，route 只负责传入 `projectId`。
- 2026-06-11：服务边界测试覆盖成功、空 message、非法 approvalStatus、script_parse_error、needs_configuration。
- 2026-06-11：验证通过 `pnpm test`、`pnpm lint`、`pnpm build`，构建中 route 显示为动态服务端接口。

## Follow-up

- Issue 035：前端文案页通过 hook/client 调用 `/api/projects/:projectId/script-agent`。

## Blocked by

- Issue 033
