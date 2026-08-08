# Issue 087 - Agent Session Isolation Audit

Status: Done

## What to build

审计文本智能体、后期智能体和发布智能体的 session 隔离，确认每个 agent turn、artifact 讨论、tool/skill 调用和下游阶段都携带明确的 workspace、session、parentSession、agentRole 和 artifact 关系。

## User pain

后期和发布已经被设计成第二、第三智能体，但如果它们共享隐式上下文或只靠页面状态传递，就会在多项目、多视频或失败重试时混用文案、音频、视频和发布状态。

## Architecture boundary

- agent/session module：负责 session identity、parent-child relation 和 agent role。
- workflow service：负责把 session metadata 传给 stage service。
- artifact module：负责把 artifact 与 session/project 关联。
- UI：只展示 session/tool/skill 状态，不推断 session 来源。
- external adapters：只消费 service 传入的显式上下文。

## Acceptance criteria

- [x] 审计文本、后期、发布三类 agent 的 session 创建和恢复路径。
- [x] 确认 `sessionKind`、`parentSessionId`、`workspaceId`、`agentRole`、`artifactId` 有明确来源。
- [x] 对缺失的 session metadata 新增测试或修复 issue。
- [x] UI 不通过空数组、路径字符串或阶段名称推断 agent session 状态。
- [x] 失败重试不会把旧项目或旧 artifact 的上下文带入新任务。
- [x] 产出审计记录并更新 PRD 当前状态。

## Implementation notes

- 审计记录见 `docs/AGENT_SESSION_ISOLATION_AUDIT.md`。
- 修复了一个实际缺口：script、post-production、publish 三个 agent service 之前只把 `sessionId` 写入 artifact，没有同步写入 `agentSessions/index.json`。
- 修复后：
  - script agent 写入 `main` session，`agentRole=script`，`artifactId=script artifact`。
  - post-production agent 写入 `subagent` session，`parentSessionId=script sessionId`，`agentRole=post_production`。
  - publish agent 写入 `subagent` session，`parentSessionId=post-production sessionId`，`agentRole=publish`。
- 后续 UI 截图和失败状态展示仍由 Issue 088 覆盖。

## Verification

- `pnpm vitest run lib/agents/script-agent-service.test.ts`
- `pnpm vitest run lib/post-production/post-production-agent-service.test.ts`
- `pnpm vitest run lib/publish/publish-agent-service.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

## Blocked by

- Issue 085
