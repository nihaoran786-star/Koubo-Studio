# 052 - Tauri Sidecar 本地后端打包与生产承载

状态：Done

## What to build

为 Windows Tauri 生产包实现可分发的 local backend / sidecar 承载方案，让静态桌面 shell 能连接本地后端并使用现有 API-backed 数字人生产链路。

当前已经完成：

- `GET /api/projects/:projectId/desktop-runtime` 后端健康检查。
- 前端 API client 可通过 `NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL` 指向 local backend。
- 前端 API client 在后端缺失时统一返回 `desktop_backend_missing`。
- `pnpm smoke:desktop-backend` 可验证本地 backend 是否能承载 desktop runtime health。
- `pnpm desktop:build` 已加预检，能识别准备好的 Tauri backend resources。
- `pnpm desktop:build` 会生成 Next standalone backend、准备 Tauri resources，并产出 Windows exe/NSIS 安装包。

这个 issue 要完成真正的生产承载：Tauri 启动应用时必须有一个可用本地后端进程，或能连接到明确配置的本地服务。优先方案是把 Next/Node backend 打包成 Tauri sidecar；如果 Node 后端无法直接自包含，需要先选定 `pkg`、`nexe`、独立 Node runtime 分发，或替代的本地服务方案。

## Acceptance criteria

- [x] 明确 sidecar 打包方案的第一层产物：先用 Next standalone 产出 `.next/standalone/server.js`，后续再封装为 Tauri sidecar 可执行文件或附带 Node runtime。
- [x] Tauri 生产配置能启动或连接 local backend，并把前端 API base 指向该 backend。
- [x] `pnpm desktop:build` 不再被预检阻止；预检通过模式为 `resource_sidecar`。
- [x] 生产桌面包打开后，`desktop-runtime` health 显示 `local_backend_ready`。
- [x] 文案、音频、数字人、后期、发布这些 API-backed 操作在生产桌面包中不再走 `static_only` 或 `desktop_backend_missing`。
- [x] 新增或更新 smoke/E2E，覆盖 backend 产物承载路径：已验证 `.next/standalone/server.js` 可启动并通过 `/desktop-runtime` smoke。

## Current implementation notes

- 新增 `NEXT_DESKTOP_BACKEND=1` Next 构建模式，对应 `output: 'standalone'`。
- 新增 `pnpm build:desktop:backend`，会生成 `.next/standalone/server.js` 并运行 artifact preflight。
- 新增 `scripts/desktop-backend-artifact-preflight.mjs`，用于检查 standalone server 产物是否存在。
- 已用 `node .next/standalone/server.js` 启动 standalone backend，并通过 `pnpm smoke:desktop-backend` 检查 `/api/projects/:projectId/desktop-runtime`。
- 新增 `scripts/prepare-desktop-backend-bundle.mjs`，把 `.next/standalone`、`.next/static`、`public` 和当前 Node runtime 准备到 `src-tauri/resources/koubo-backend`。
- Tauri release 启动时会在资源目录中查找 `koubo-backend/node.exe` 和 `server.js`，以 `127.0.0.1:3100` 启动本地 backend，并在应用退出时清理进程。
- release exe runtime smoke 已验证：`GET http://127.0.0.1:3100/api/projects/desktop-smoke/desktop-runtime` 返回 `runtimeStatus: local_backend_ready`。
- `pnpm smoke:desktop-backend` 和 `pnpm smoke:desktop-release` 已收紧为必须返回 `script_agent`、`audio_agent`、`digital_human`、`post_production`、`publish_agent` 五个能力，避免只证明 shell/health 启动而没有完整生产链路 API。

## Blocked by

- None.
