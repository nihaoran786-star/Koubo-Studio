# Issue 035 - 文案页 Client/Hook 接入 Script Agent API

## What to build

新增前端 client/hook，让数字人文案页通过 `/api/projects/:projectId/script-agent` 调用文本 agent。页面组件只渲染状态和触发动作，不直接解析 Pi reply、不直接写 artifact、不直接判断 Node/Pi/session 细节。

## User pain

后端已经有 script-agent route，但文案页仍是本地模拟 AI。用户输入视频意图后，右侧聊天框还不能真实调用 AI，也不能把结果落到左侧结构化文案。

## Acceptance criteria

- [x] 新增 script agent client 或 hook。
- [x] hook 状态包含 `idle`、`running`、`done`、`needs_configuration`、`script_parse_error`、`agent_error`。
- [x] hook 调用 `/api/projects/:projectId/script-agent`。
- [x] hook 将成功返回的 artifact content 映射到当前 `ScriptDraft`。
- [x] 文案页不直接解析 Pi JSON。
- [x] 文案页不直接读取 artifact 文件路径、session 文件或 Node 版本。
- [x] `needs_configuration` 显示可操作提示。
- [x] 有组件或 hook 测试覆盖成功、配置缺失、解析失败。
- [ ] 后续 UI 截图/E2E 覆盖文案页真实调用路径。

## Progress

- 2026-06-11：新增 `script-agent-client`，负责 endpoint、请求和 API 结果到 `ScriptDraft` 的映射。
- 2026-06-11：新增 `useScriptAgent`，状态包含 idle/running/done/needs_configuration/script_parse_error/agent_error。
- 2026-06-11：`IdeaChamber` 的“生成文案”改为调用 `useScriptAgent`，不再本地模拟生成左侧文案。
- 2026-06-11：`needs_configuration` 和 `script_parse_error` 会在聊天区上方显示可操作提示。
- 2026-06-11：验证通过 `pnpm test`、`pnpm lint`、`pnpm build`。

## Follow-up

- Issue 036：补 Playwright 或等价 E2E/截图测试，覆盖文案页真实调用路径和错误状态。

## Blocked by

- Issue 034
