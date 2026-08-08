# Issue 097 - Agent Session Timeline API

Status: Done

## What to build

为项目级历史恢复和审计面板增加只读 agent session timeline API，让 UI 可以按项目读取 script、voice、digital-human、post-production、publish 的 session/artifact 链路，而不是直接读取 workspace 文件。

## Why now

Issue 096 已把 HeyGem render artifact 从 `script` 角色拆到 `digital_human`。当前只读详情接口只能通过已知 `sessionId` 查询单个 session；后续历史会话 UI 如果要展示项目完整链路，缺少项目级入口，容易把 workspace 文件读取或空数组业务判断塞回页面组件。

## Architecture boundary

- agent module：负责读取 session index 和 artifact index，组装 timeline。
- route handler：只根据 query 分发 `sessionId` detail 或 `view=timeline`，不做业务推断。
- UI：后续只能消费 API 返回的 `status/source/items`，不直接读取 `sessions/agents/index.json` 或 `artifacts/index.json`。
- adapter/external system：不参与，本 issue 是只读恢复接口。

## Acceptance criteria

- [x] 新增项目级 timeline service。
- [x] Timeline item 包含 `session` 和可选 `artifactRecord`。
- [x] 过滤掉不属于当前 workspace 的 session。
- [x] `GET /api/projects/:projectId/agent?view=timeline` 返回 timeline。
- [x] 保留 `GET /api/projects/:projectId/agent?sessionId=...` 既有行为。
- [x] 未知 view 返回明确 `invalid_view`。
- [x] 单测覆盖 service 和 route handler。

## Verification

- `pnpm vitest run lib/agents/agent-session-timeline.test.ts lib/agents/agent-route-handler.test.ts lib/agents/agent-session-detail.test.ts lib/agents/agent-session-index.test.ts lib/artifacts/artifact-index.test.ts`

## Blocked by

- 无。
