# 057 - 桌面后端 Node 22 Runtime Guard

状态：Done

## What to build

桌面生产包准备 local backend sidecar 时，必须拒绝打包低于 Node 22.19.0 的 runtime，并支持通过 `DESKTOP_BACKEND_NODE_PATH` 显式指定合格 Node 可执行文件。

## Why now

项目级 Next.js 本地后端要求 Node >= 22.19.0。该切片实施时开发机默认 Node 是 20.20.0，而 052 的 sidecar 打包脚本此前默认复制 `process.execPath`。这会导致桌面包表面构建成功，但生产后端无法满足项目运行要求。

## Acceptance criteria

- [x] `prepareDesktopBackendBundle` 在复制前读取待打包 Node runtime 版本。
- [x] Node 版本低于 22.19.0 时返回稳定错误码 `node_runtime_unsupported`。
- [x] CLI 支持 `DESKTOP_BACKEND_NODE_PATH` 指向 Node 22.19.0+。
- [x] 单测覆盖合格 runtime 和 Node 20 被拒绝。
- [x] 文档记录当前桌面打包需要 Node 22.19.0+。

## Implementation notes

- 版本下限：`MIN_DESKTOP_BACKEND_NODE_VERSION = 22.19.0`。
- `desktop:build` 仍走 `build:desktop:backend -> prepare-desktop-backend-bundle -> desktop-build-preflight -> tauri build`。
- 当前机器默认 `node -v` 为 `v20.20.0`，因此在未设置 `DESKTOP_BACKEND_NODE_PATH` 时，准备 sidecar 应失败而不是产出不可用包。
- 2026-06-12 复查时修复了 `DESKTOP_BACKEND_NODE_PATH` 指向既有 `src-tauri/resources/koubo-backend/node.exe` 的自复制场景：脚本会先暂存 Node runtime，再清空并重建 resources，避免 ENOENT。
- Tauri release sidecar 现在读取 `KOUBO_BACKEND_PORT`/`PORT`，默认仍为 3100；smoke runner 会从 backend URL 提取端口并传给 release exe，避免误连已有 dev server。

## Verification

```powershell
pnpm vitest run scripts/prepare-desktop-backend-bundle.test.mjs
pnpm build:desktop:backend
node scripts/prepare-desktop-backend-bundle.mjs
pnpm test
pnpm typecheck
pnpm build
```

其中 `node scripts/prepare-desktop-backend-bundle.mjs` 在该切片记录的 Node 20.20.0 环境下预期失败，错误码应为 `node_runtime_unsupported`。

2026-06-12 追加验证（历史记录；其中旧 Pi smoke 脚本现已删除，不是现行命令）：

```powershell
pnpm vitest run scripts/prepare-desktop-backend-bundle.test.mjs scripts/desktop-release-smoke.test.mjs
$env:DESKTOP_BACKEND_NODE_PATH='C:\Users\17949\Documents\应聘\口播智能体\src-tauri\target\release\resources\koubo-backend\node.exe'
pnpm desktop:build
```

历史结果包含当时已存在、现已删除的旧 Pi smoke：共 4 个脚本测试文件、17 个用例通过；`pnpm desktop:build` 通过并产出 `src-tauri\target\release\koubo-agent.exe` 和 NSIS 安装包。当前 Provider 文案链路使用 `pnpm smoke:model-provider` 验证。
