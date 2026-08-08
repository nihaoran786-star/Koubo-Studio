# Issue 050 - Turbopack NFT 构建告警与 workspace 文件路径收敛

Status: Done

## What to build

消除 `pnpm build` 中由 avatar/audio asset workspace 文件路径触发的 Turbopack NFT warning，避免构建追踪误判为“整个项目被 trace”。目标是让生产构建没有残留告警，更接近可发布状态。

## User pain

数字人链路已经有多条 API route 会读写 workspace 文件。构建期如果持续出现 NFT warning，后续桌面端/服务端发布会难以判断哪些 warning 是可忽略、哪些是真风险。

## Architecture boundary

- UI：不改。
- Route：不改上传业务逻辑。
- Asset service：只调整 workspace 动态路径的 Turbopack ignore 注释，保持路径安全校验不变。
- Filesystem：仍通过 `assertInsideRoot` 约束在 workspace 内。

## Acceptance criteria

- [x] `avatar-asset` 动态 workspace 路径使用 Turbopack 支持的 `/*turbopackIgnore: true*/` 格式。
- [x] `audio-asset` 同类动态路径同步修正，避免后续出现同类告警。
- [x] avatar/audio asset 单测通过。
- [x] `pnpm build` / `pnpm build:desktop:backend` 不再出现 Turbopack NFT warning。
- [x] 不改变上传文件类型、大小、路径隔离和 index 写入行为。

## Implementation notes

- 修正 `lib/digital-human/avatar-asset.ts` 中 avatar 目录、index 文件、上传文件路径的动态 `path.join` 注释。
- 同步修正 `lib/audio/audio-asset.ts` 中 audio 目录、index 文件、上传文件路径的动态 `path.join` 注释。
- 保留 `assertInsideRoot` 校验，不把路径拼接逻辑上移到 route 或 UI。
- 2026-06-12 复跑 `pnpm desktop:build` 时 warning 回归，但来源已从 avatar/audio asset 转移到 `lib/workspaces/workspace-manager.ts` 和 `next.config.mjs` import trace。当前 warning 指向 workspace root 动态路径过宽和 `next.config.mjs` 被 route trace，后续需要在 workspace-manager / config 边界继续收敛，而不是回退 avatar/audio 路径保护。
- 2026-06-12 已在 `lib/workspaces/workspace-manager.ts` 的 workspace root、project root、files/context/outputs/artifacts/sessions 等运行时路径拼接处补充 `/*turbopackIgnore: true*/`，保持 `assertInsideRoot` 路径隔离不变。复跑 `pnpm build:desktop:backend` 通过，未再出现 Turbopack/NFT warning。

## Verification

```bash
pnpm vitest run lib/digital-human/avatar-asset.test.ts lib/digital-human/avatar-asset-route-handler.test.ts lib/audio/audio-asset.test.ts
pnpm vitest run lib/workspaces/workspace-manager.test.ts
pnpm lint
pnpm build:desktop:backend
```
