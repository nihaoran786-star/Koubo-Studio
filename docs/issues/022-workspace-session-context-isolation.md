# Issue 022 - Workspace / Context / Session 隔离

## What to build

建立 workspace、context、session、artifact、agentRole 的隔离模型，确保多项目、多阶段、多 agent 不互相污染。

## User pain

口播智能体需要多个项目并行，每个项目又包含文案、音频、数字人、后期、发布等阶段。如果上下文和 session 混在一起，AI 会串项目、串阶段、串 agent 角色。

## Acceptance criteria

- [x] 每个 workspace 有明确 `workspaceId`、`workspacePath`、`projectId`、`featureType`。
- [x] 每个 session 有 `sessionId`、`sessionKind`、`parentSessionId`、`agentRole`、`artifactId`。
- [x] 所有 artifact 路径都必须留在当前 project workspace 内。
- [ ] 空数据、未支持、受限、错误、加载中都有明确状态。
- [ ] 子 agent 不共享私有工作上下文，只共享 artifact 引用。

## Progress

- 2026-06-11：`ProjectWorkspace` 增加 `workspaceId`、`artifactsPath`、`agentSessionsPath`。
- 2026-06-11：新增 `createAgentSessionMetadata`，要求 subagent 必须带 `parentSessionId`，remote session 必须带 `remoteConnectionId`。
- 2026-06-11：新增 `resolveArtifactPath` 和 `createArtifactRecord`，artifact 路径被限制在当前 project workspace 的 `artifacts/<type>/` 下。

## Blocked by

- Issue 019
- Issue 021
