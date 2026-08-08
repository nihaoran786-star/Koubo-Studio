# 065 - HeyGem Compatible API Smoke

状态：Done

## What to build

补强 HeyGem 服务化 API 契约，并新增可重复的本地 compatible API smoke，验证数字人阶段可以通过 HTTP 后端生成视频文件、校验输出并保存 render artifact。

## Why now

043/044 已经建立 HeyGem 输入契约、形象素材、adapter、render artifact 和默认跳过的集成测试，但 HTTP API 模式只确认请求成功，没有解析 API 返回的输出路径，也缺少一个不依赖真实 HeyGem 服务的可重复 smoke。继续接真实 HeyGem 前，需要先把 compatible API 的最小契约固定下来。

## Acceptance criteria

- [x] HeyGem HTTP API `/render` 可返回 `status: ok` 和 `outputPath`。
- [x] API 返回 `adapter_error` / `failed` / `error` 时映射为 typed adapter error。
- [x] API 返回的 `outputPath` 仍必须位于当前 workspace `artifacts/render` 内。
- [x] Adapter 对 API 输出视频继续执行存在性和 duration 校验。
- [x] 新增 `pnpm smoke:heygem-local-api`。
- [x] smoke 默认跳过，只有 `RUN_HEYGEM_LOCAL_API_SMOKE=1` 时执行。
- [x] smoke 启动本地 HeyGem-compatible `/render` 服务。
- [x] smoke 使用 ffmpeg 写出短 mp4，走 `generateHeyGemRender` 保存 render artifact。
- [x] smoke 结束后清理测试 workspace 和本地服务。

## Verification

```powershell
pnpm vitest run lib/digital-human/heygem-adapter.test.ts lib/digital-human/heygem-service.test.ts
pnpm typecheck
pnpm smoke:heygem-local-api
$env:RUN_HEYGEM_LOCAL_API_SMOKE='1'
pnpm smoke:heygem-local-api
```

真实 smoke 结果：

```text
1 passed
```

## Residual risk

本 issue 证明的是 HeyGem-compatible API 契约和项目内 service/adapter/artifact 链路，不等同于真实 HeyGem 官方或本地完整 runtime 的质量验收。真实 HeyGem runtime/API 仍需要在有可用服务地址、形象素材和音频输入时执行 `RUN_HEYGEM_INTEGRATION=1` 的集成测试。
