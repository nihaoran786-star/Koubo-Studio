# 060 - Release Sidecar Node 24 Runtime Smoke

状态：Done

## What to build

使用满足项目级本地后端要求的 Node runtime 重新构建桌面生产包，并验证 release exe 启动后的 local backend 能返回 `desktop-runtime` 健康状态和 `script_agent/node_runtime ready`。

## Why now

057 和 058 已经分别完成打包阶段 Node guard 与运行时 readiness 输出。需要继续验证真实 release exe，而不是只验证脚本层资源准备。

## Acceptance criteria

- [x] 找到本机可用 Node 22.19.0+ runtime。
- [x] 用 `DESKTOP_BACKEND_NODE_PATH` 准备 sidecar backend。
- [x] `src-tauri/resources/koubo-backend/node.exe -v` 返回 Node 22.19.0+。
- [x] `pnpm desktop:build` 成功生成 release exe 和 NSIS 安装包。
- [x] 启动 release exe 后，`GET /api/projects/:projectId/desktop-runtime` 返回 `local_backend_ready`。
- [x] health `requirements` 显示 `script_agent/node_runtime/ready`。
- [x] 修复 Windows release 中 `\\?\C:\...` 路径传给 Node 导致 `EISDIR path: 'C:'` 的启动问题。
- [x] smoke 后清理 release 进程。

## Implementation notes

本机可用 runtime：

```text
C:\Users\17949\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
v24.14.0
```

打包命令：

```powershell
$env:DESKTOP_BACKEND_NODE_PATH='C:\Users\17949\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
pnpm desktop:build
```

Release smoke 返回：

```json
{
  "status": "available",
  "source": "desktop_runtime",
  "runtimeStatus": "local_backend_ready",
  "requirements": [
    {
      "id": "node_runtime",
      "capability": "script_agent",
      "status": "ready",
      "requiredVersion": "22.19.0",
      "actualVersion": "24.14.0"
    }
  ]
}
```

## Follow-up

该切片完成时，真实 Provider 文案调用仍待验证。当前现行链路为 Provider Resolution → Script Agent → 原生 OpenAI-compatible adapter，并使用 `pnpm smoke:model-provider` 验证 Provider → 文案 artifact。
