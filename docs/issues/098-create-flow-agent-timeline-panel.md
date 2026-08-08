# Issue 098 - Create Flow Agent Timeline Panel

Status: Done

## What to build

在创作流程页增加只读“生产链路”面板，消费 Issue 097 的 project agent session timeline API，让用户能看到当前项目中 script、voice、digital-human、post-production、publish 的 session/artifact 链路。

## Why now

Issue 097 已提供 `GET /api/projects/:projectId/agent?view=timeline`。如果前端不接入，历史恢复和失败排查仍停留在后端能力，用户无法确认当前项目的文案、音频、数字人、后期和发布产物是否属于同一条链路。

## Architecture boundary

- API client：构造 `/agent?view=timeline` 请求，并在桌面后端缺失时返回稳定错误。
- hook：维护 `loading/result/refresh`，不读取 workspace 文件。
- Create Flow UI：只渲染 timeline 状态和 item，不推断底层 session 文件或 artifact 路径。
- route/service：复用 Issue 097，不在本 issue 中改外部 runtime 或写入逻辑。

## Acceptance criteria

- [x] 新增 agent session timeline client。
- [x] 新增 `useAgentSessionTimeline()` hook。
- [x] 创作页显示可折叠“生产链路”面板。
- [x] 面板展示角色、artifact 类型、状态和 artifact/session id。
- [x] 面板支持刷新，且后端缺失时展示稳定错误信息。
- [x] E2E 覆盖 timeline API 数据可见。
- [x] 不让 UI 直接读取 workspace 或 session/artifact index 文件。

## Verification

- `pnpm vitest run lib/agents/agent-session-timeline-client.test.ts lib/agents/agent-session-timeline.test.ts lib/agents/agent-route-handler.test.ts`
- `pnpm test:e2e tests/e2e/script-page.spec.ts -g "agent session timeline"`

## Blocked by

- Issue 097
