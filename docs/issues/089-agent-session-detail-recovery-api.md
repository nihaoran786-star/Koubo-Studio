# Issue 089 - Agent Session Detail Recovery API

Status: Done

## What to build

新增只读 agent session detail / recovery API，让后续历史会话、审计面板和失败恢复可以通过明确接口读取 agent session、parent session、agent role、artifact chain 和 tool/skill 摘要，而不是让 UI 直接读取 workspace 文件或根据路径猜测状态。

## User pain

Issue 087 已经把 script、post-production、publish 三个智能体的 session metadata 写入 `agentSessions/index.json`，能证明多智能体隔离关系。但当前 session index 只是内部索引，不是给 UI 直接消费的历史详情接口。后续如果要展示“这条视频经历了哪些智能体、调用了哪些 skill、产出了哪些 artifact”，需要一个稳定 API。

## Architecture boundary

- agent/session module：负责读取 session index 和关联 artifact record。
- API route：返回标准 `status/source/data/error`。
- UI：只调用 API，不直接读取 workspace 文件。
- artifact module：提供 artifact metadata，不暴露任意文件路径。
- external adapters：不参与该 issue。

## Acceptance criteria

- [x] 新增只读 session detail service，按 `projectId` 和 `sessionId` 查询。
- [x] 返回 `sessionKind`、`parentSessionId`、`workspaceId`、`agentRole`、`artifactId` 和关联 artifact record。
- [x] 对不存在 session、跨 workspace session、损坏 index 返回稳定错误码。
- [x] 新增 API route 或现有 agent route 的只读分支。
- [x] 新增测试覆盖 script/main、post/subagent、publish/subagent 三类 session。
- [x] UI 不直接读取 `agentSessions/index.json`。

## Implementation notes

- 新增 `getAgentSessionDetail()` 作为只读 service。
- `GET /api/projects/:projectId/agent?sessionId=...` 返回 session detail。
- 返回内容包含当前 session、parent session 和关联 artifact record。
- 稳定错误码覆盖：
  - `missing_session_id`
  - `session_not_found`
  - `workspace_mismatch`
  - `index_error`
- UI 后续做历史会话或失败恢复时应调用该 API，不直接读取 workspace 内部文件。

## Verification

- `pnpm vitest run lib/agents/agent-session-detail.test.ts`
- `pnpm vitest run lib/agents/agent-route-handler.test.ts`
- `pnpm vitest run lib/agents/agent-session-index.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

## Blocked by

- Issue 087
