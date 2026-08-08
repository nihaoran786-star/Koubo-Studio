# Issue 096 - Render Artifact Role Isolation

Status: Done

## What to build

审计并修正 HeyGem 数字人生成代码工作流的 artifact/session 角色归属，避免 render artifact 继续写成 `agentRole=script`。

## Why now

IndexTTS2 音频代码工作流已经改为 `agentRole=voice`，可以和文本智能体的 `script` session 区分。当前 render artifact 仍由 `saveRenderArtifact()` 写入 `agentRole=script`，后续历史恢复、artifact 链路审计和多阶段失败排查会把数字人生成误认为文本智能体输出。

## Architecture boundary

- artifact module：负责 render artifact record 的角色归属。
- digital-human service：负责在 HeyGem 成功后写入明确 session metadata。
- UI：只展示 render artifact 和 runtime 状态，不推断 session 来源。
- adapter：HeyGem adapter 只执行外部 API/脚本，不写 session index。

## Acceptance criteria

- [x] 新增明确的 render/digital-human 工作流角色 `digital_human`。
- [x] `saveRenderArtifact()` 的 artifact record 不再使用 `agentRole=script`。
- [x] HeyGem 数字人生成成功或失败并落盘 artifact 后写入 agent session index，包含 `workspaceId`、`workspacePath`、`agentRole`、`artifactId`。
- [x] 现有 script、voice、post-production、publish 查询互不污染。
- [x] 单测覆盖 render artifact record 和 session index。
- [x] E2E 文案路径仍通过，并清理测试产物。

## Progress

- 2026-06-11：`AgentRole` / `ArtifactAgentRole` 新增 `digital_human`。
- 2026-06-11：render artifact index 统一写入 `agentRole=digital_human`。
- 2026-06-11：HeyGem service 在 ready/failed render artifact 落盘后追加数字人 session metadata。

## Verification

- `pnpm vitest run lib/artifacts/render-artifact.test.ts lib/digital-human/heygem-service.test.ts lib/agents/agent-session-index.test.ts`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- `pnpm typecheck`
- `pnpm build`

## Blocked by

- 无。
