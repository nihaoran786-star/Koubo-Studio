# Issue 032 - Script Artifact 项目上下文持久化

## What to build

在 artifact/index 底座上，实现数字人文案的 script artifact 读写。文本智能体生成的结构化文案必须保存为 workspace 内的 artifact 文件，并写入 artifact index，后续 IndexTTS2、HeyGem、后期和发布阶段只能消费 approved script artifact。

## User pain

目前 artifact index 已经能记录 artifact，但还没有第一个真实业务 artifact。文案页如果直接把文案存在 React state 或 localStorage，后续音频、数字人和发布阶段仍然无法可靠恢复与追踪。

## Acceptance criteria

- [x] 定义 script artifact 数据结构：title、hook、body、caption、tags、durationSeconds、voiceNotes、shotNotes、riskNotes。
- [x] 支持保存 draft script artifact。
- [x] 支持保存 approved script artifact。
- [x] 支持读取单个 script artifact。
- [x] 支持列出当前 project 的 script artifacts。
- [x] script artifact 文件路径必须在 `artifacts/script/` 下。
- [x] 写入 artifact 文件后同步写入 artifact index。
- [x] JSON 损坏时返回明确 `artifact_error` 或 `index_error`。
- [x] 有单元测试覆盖保存、读取、approved 状态、路径越界和损坏 JSON。

## Progress

- 2026-06-11：新增 `ScriptArtifactContent` 和 `ScriptArtifact` 数据结构。
- 2026-06-11：新增 `saveScriptArtifact`、`getScriptArtifact`、`listScriptArtifacts`。
- 2026-06-11：draft script 写入 artifact index 时为 `draft`，approved script 写入 artifact index 时为 `ready`。
- 2026-06-11：验证通过 `pnpm test`、`pnpm lint`、`pnpm build`，测试 workspace 已清理。

## Follow-up

- Issue 033：新增文本 agent service，把 Pi 返回的结构化 JSON 转成 script artifact。

## Blocked by

- Issue 031
