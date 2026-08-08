# Issue 031 - Artifact 与 Agent Session 索引持久化

## What to build

在当前 workspace 隔离底座上，增加 artifact index 和 agent session index 的持久化。当前已有类型、路径保护和 metadata 创建函数，但还没有把记录写入 workspace 的索引文件，也没有读取/列出能力。

## User pain

如果 artifact 和 agent session 只存在于内存或返回值中，刷新应用后无法恢复文案、音频、数字人渲染、后期成片和发布任务，也无法追踪哪个 agent 生成了哪个 artifact。

## Acceptance criteria

- [x] 每个 project workspace 有 artifact index 文件。
- [x] 每个 project workspace 有 agent session index 文件。
- [x] 支持新增 artifact record。
- [x] 支持按 artifact type 列出 artifact。
- [x] 支持新增 agent session metadata。
- [x] 支持按 `agentRole`、`parentSessionId`、`artifactId` 查询 session。
- [x] 索引读写必须经过 workspace path guard。
- [x] 索引损坏时返回明确 `index_error`，不能让 UI 靠字符串猜。
- [x] 有单元测试覆盖新增、读取、路径越界和损坏索引。

## Progress

- 2026-06-11：新增 artifact index，路径为 `artifacts/index.json`。
- 2026-06-11：新增 agent session index，路径为 `sessions/agents/index.json`。
- 2026-06-11：新增索引读写和查询单元测试；损坏 JSON 会抛出 `index_error`。
- 2026-06-11：验证通过 `pnpm test`、`pnpm lint`、`pnpm build`，测试 workspace 已清理。
- 2026-06-11：IndexTTS2 音频代码工作流已使用 `agentRole=voice` 写入 audio artifact record 和 agent session index，不再把 audio artifact 归到 `script`。
- 2026-06-11：HeyGem 数字人代码工作流已使用 `agentRole=digital_human` 写入 render artifact record 和 agent session index，不再把 render artifact 归到 `script`。

## Follow-up

- Issue 032：把 script artifact 作为第一个真实 artifact 类型接入项目上下文读写。
- Issue 096：已完成；HeyGem render artifact 和 session index 使用 `digital_human` 角色。

## Blocked by

- Issue 022
