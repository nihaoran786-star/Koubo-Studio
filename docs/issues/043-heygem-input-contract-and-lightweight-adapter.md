# Issue 043 - HeyGem 输入契约与轻量 Adapter

Status: Done

## What to build

建立数字人阶段的 HeyGem 输入契约和轻量后端 adapter。Avatar 页面需要使用上游 script artifact 与 selected audio artifact 作为明确输入，生成数字人 render artifact。目标是轻量接入：只接必须接口、路径、状态和错误分类，不大规模迁移 HeyGem 项目代码。

## User pain

文本和音频链路已经能产生 script/audio artifact，但数字人页仍是前端假状态。用户要求 HeyGem 作为后端数字人系统接入，且 4/5 属于代码工作流，不是 AI skill 调用。没有明确输入契约，HeyGem 无法可靠消费文案和音频。

## Architecture boundary

- UI：Avatar 页面只选择/显示数字人参数、状态和结果，不直接访问 HeyGem 或文件系统。
- Hook/client：提交数字人生成请求并映射状态。
- Route/service：校验 project、script artifact、audio artifact 和 avatar 参数，返回 `status/source/error`。
- Module interface：定义 `DigitalHumanInput`、`AvatarGenerationParameters`、`RenderArtifact`。
- Adapter：唯一负责调用 HeyGem runtime/API、校验输出视频路径和错误分类。
- External system：本地或服务化 HeyGem，先支持配置路径/API，不迁移不必要代码。

## Acceptance criteria

- [x] 新增数字人输入契约，必须包含 script artifact id、audio artifact id、avatar/source 参数。
- [x] 新增 render artifact 类型或复用现有 artifact index，记录视频输出路径、duration、input artifact ids、status。
- [x] 新增 HeyGem adapter 接口，支持 mock，不在测试中启动真实 HeyGem。
- [x] 新增 service 和 API route，返回标准 `status/source/error`。
- [x] Avatar 页面接入 client/hook，生成时使用 selected audio artifact。
- [x] 缺少 script/audio artifact 时显示明确错误，不伪造成功。
- [x] 单测覆盖输入校验、service、route、adapter mock、artifact 写入。
- [x] E2E 覆盖从声音页进入数字人页并提交生成请求。
- [x] 成功后删除测试产物。

## Implementation notes

- `lib/artifacts/render-artifact.ts` 写入 render artifact，并进入现有 artifact index。
- `lib/digital-human/heygem-service.ts` 校验 script/audio artifact、avatar 参数和模式，adapter 成功后保存 render artifact。
- `app/api/projects/[projectId]/digital-human/heygem/route.ts` 提供数字人生成 API。
- `components/create-flow/avatar-chamber.tsx` 不再使用假计时成功状态，改为调用 HeyGem hook；缺文案或音频 artifact 时禁用生成并提示。
- `components/create-flow/voice-chamber.tsx` 在音频生成或恢复最新音频后上报 selected audio artifact id。

## Verification

- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`

`pnpm build` 成功，但仍有既有 Turbopack NFT warning，来源是 `lib/audio/audio-asset.ts` 经 `audio-assets` route 的文件追踪。

## Blocked by

- Issue 042

## Notes

这个 issue 只做 HeyGem 轻量接入底座。真实 HeyGem runtime 调用、人物素材管理、口型质量优化可继续拆后续 issue。
