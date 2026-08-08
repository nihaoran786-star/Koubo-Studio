# Issue 044 - HeyGem Runtime 调用、形象资产与视频校验

Status: Done

## What to build

在 043 的轻量契约基础上，把 HeyGem adapter 从“接口占位”推进到真实 runtime/API 调用。数字人阶段需要支持本地或服务化 HeyGem 配置、形象素材输入、任务执行、输出视频校验和可恢复的 render artifact。

## User pain

当前数字人页已经能把 script/audio artifact 和 avatar 参数提交到后端，但默认 adapter 只返回 `runtime_missing`。用户需要 HeyGem 真正生成数字人视频，否则后续剪辑页面没有可消费的视频 artifact。

## Architecture boundary

- UI：Avatar 页面只选择形象、模式、上传素材和展示生成状态，不直接拼 HeyGem 命令或访问文件系统。
- Hook/client：提交生成请求、上传 avatar asset、展示标准状态。
- Route/service：校验 workspace、artifact、avatar asset、HeyGem 配置和任务状态。
- Adapter：唯一负责调用 HeyGem runtime/API、轮询任务、校验输出视频。
- Artifact：render artifact 记录输入 artifact id、avatar asset、输出视频路径、duration、status、error。
- External system：HeyGem 本地项目或服务化 API。

## Acceptance criteria

- [x] 新增 HeyGem 配置读取：支持本地 runtime 路径或服务 API 地址，不把密钥/路径写死在 UI。
- [x] Avatar 上传素材进入 workspace asset 管理，`avatar.source=upload` 时必须带可校验 asset path。
- [x] HeyGem adapter 真实调用 runtime/API，返回 `ok`、`adapter_error` 或 `timeout` 类错误。
- [x] Adapter 校验输出视频文件存在、位于 workspace render artifact 目录内，并能读取基础 duration。
- [x] render artifact 支持失败记录或任务状态恢复，避免刷新后丢失数字人生成结果。
- [x] Avatar 页面展示 runtime missing、任务失败、超时、输出无效等不同错误。
- [x] 单测覆盖配置缺失、avatar asset 缺失、adapter 成功、输出越界、输出缺失。
- [x] E2E 使用 mock HeyGem 验证上传形象和生成状态，不启动真实 HeyGem。
- [x] 集成测试可在配置了 HeyGem runtime 的机器上手动开启，默认 CI 不依赖真实模型。
- [x] 成功后清理测试产物。

## Implementation notes

- `lib/digital-human/heygem-adapter.ts` 支持 `HEYGEM_API_URL` / `HEYGEM_API_KEY` / `HEYGEM_SCRIPT_PATH` / `HEYGEM_TIMEOUT_MS`，本地脚本和服务 API 都走 adapter 边界。
- HeyGem 输出视频必须落在当前 workspace 的 `artifacts/render` 目录内，并通过 ffprobe 或注入的 `probeDuration` 读取时长。
- `lib/digital-human/avatar-asset.ts` 新增 avatar asset 管理，上传视频保存到 `workspace/files/avatar`，并维护 `index.json`。
- `app/api/projects/[projectId]/avatar-assets/route.ts` 提供形象素材上传 API。
- Avatar 页面上传视频后使用返回的 `asset.path` 作为 `avatar.assetPath` 提交给 HeyGem service。
- `upload` 形象在 service 层必须校验 `assetPath` 位于 `workspace/files` 内；缺失或越界不会调用 adapter。
- HeyGem adapter 失败时，service 会写入 `failed` render artifact，记录 planned output path、输入 artifact id 和错误码/消息。
- `lib/digital-human/heygem-adapter.integration.test.ts` 提供默认跳过的集成测试入口；配置 `RUN_HEYGEM_INTEGRATION=1`、`HEYGEM_API_URL` 或 `HEYGEM_SCRIPT_PATH`、`HEYGEM_INTEGRATION_AUDIO` 后可手动验证真实 HeyGem。
- `lib/digital-human/heygem-local-api-smoke.integration.test.ts` 提供 HeyGem-compatible API smoke；本地 `/render` 服务写出 mp4 后，项目走 service/adapter/render artifact 全链路验证。
- 本机已临时启用 `RUN_HEYGEM_INTEGRATION=1`，生成一个位于 Duix host data root 内的短 WAV 作为 `DUIX_AVATAR_INTEGRATION_AUDIO`，跑通 `pnpm smoke:heygem-runtime`。preflight 成功探测本地 Duix/HeyGem API，integration test 通过 adapter 生成短数字人视频。临时 WAV 已删除。

## Verification

- `pnpm vitest run lib/digital-human/avatar-asset.test.ts lib/digital-human/avatar-asset-route-handler.test.ts lib/digital-human/heygem-adapter.test.ts lib/digital-human/heygem-service.test.ts`
- `pnpm lint`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- `pnpm test`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts` after failed render artifact changes
- `pnpm vitest run lib/digital-human/heygem-adapter.integration.test.ts lib/digital-human/heygem-adapter.test.ts lib/digital-human/heygem-service.test.ts`
- `RUN_HEYGEM_LOCAL_API_SMOKE=1 pnpm smoke:heygem-local-api`
- `$env:RUN_HEYGEM_INTEGRATION='1'; $env:DUIX_AVATAR_INTEGRATION_AUDIO='<duix-host-data-root>\\temp\\koubo-heygem-smoke-audio.wav'; pnpm smoke:heygem-runtime`

`pnpm build` 成功，但仍有 Turbopack NFT warning，当前指向 `lib/digital-human/avatar-asset.ts` 经 `avatar-assets` route 的文件追踪。该 warning 与上传 route 的文件系统写入有关，未阻断构建。

## Blocked by

- Issue 043

## Notes

这个 issue 只做 HeyGem 真实生成与形象资产，不进入后期剪辑。后期剪辑应从 render artifact 消费视频，另拆 issue。
