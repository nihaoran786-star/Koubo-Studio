# Issue 039 - IndexTTS2 Adapter 与音频参数契约

## What to build

建立 IndexTTS2 的代码工作流底座：定义声音克隆/音频生成参数模型、artifact 输出契约、后端 adapter 接口和前端参数映射所需的状态结构。这个 issue 先打通“参数 -> adapter 请求 -> audio artifact 记录”的可测试链路，不直接依赖 AI skill 执行。

## User pain

用户要求 IndexTTS2 必须作为真实代码工作流接入，不是让 AI 调 skill。前端还要映射语速、情绪变化、情绪参考音频上传等参数。如果没有统一参数契约，后续 UI、后端脚本、artifact 和数字人阶段会各自发明字段，导致链路不可恢复、不可测试。

## Architecture boundary

- UI：只渲染和编辑音频参数，不直接调用文件系统或 Python/PowerShell。
- Hook/client：负责提交音频生成请求，并把 API 结果映射为页面状态。
- Route：校验项目、script artifact、参数和上传引用，返回明确 `status/source/error`。
- Module interface：定义 `VoiceCloneInput`、`VoiceGenerationParameters`、`AudioArtifact`。
- Adapter：唯一允许调用 IndexTTS2 runtime、PowerShell/Python 脚本或本地音频处理工具的层。
- External system：IndexTTS2 runtime，默认可配置路径，不假设一定安装在项目目录内。

## Acceptance criteria

- [x] 新增音频参数类型，覆盖 text、referenceAudio、speed、emotionText、emotionAlpha、emotionReferenceAudio、seed/useRandom、output format。
- [x] 新增 audio artifact 类型或复用 artifact index，记录输入参数、输出路径、duration、status、source。
- [x] 新增 IndexTTS2 adapter 接口，支持依赖注入，测试时不启动真实模型。
- [x] adapter 会把 `outputFormat` 显式传给 PowerShell wrapper；真实 wrapper 校验输出扩展名与 `OutputFormat` 一致，并用 ffmpeg 转换 mp3。
- [x] 新增 service 层，把项目 workspace、script artifact 和参数转换成 adapter 调用。
- [x] 新增 API route，返回标准 `status/source/error`。
- [x] 前端声音克隆页面接入 client/hook 状态模型，但不改变现有视觉风格。
- [x] 单测覆盖参数校验、service、adapter mock、artifact 写入。
- [x] E2E 覆盖声音页面参数编辑和提交状态。
- [x] 成功后删除截图和测试产物。

## Blocked by

- Issue 038

## Notes

这个 issue 只建立 IndexTTS2 代码工作流。真实模型质量调参、长音频分段、批量生成和 HeyGem 口型同步进入后续 issue。

## Progress

- 新增 `lib/audio/voice-generation.ts`，定义并校验 IndexTTS2 音频生成参数。
- 新增 `lib/artifacts/audio-artifact.ts`，把生成音频写入 artifact index。
- 新增 `lib/audio/indextts2-adapter.ts`，作为唯一允许触碰真实 IndexTTS2 runtime 的 adapter 边界。
- IndexTTS2 PowerShell wrapper 已支持 `-OutputFormat wav|mp3`；`wav` 可直接复制 raw output，`mp3` 会通过 ffmpeg 显式转码。
- 固定 seed 与随机 seed 已互斥：`useRandom=true` 时参数归一化会清空 seed，adapter 也不会把 `-Seed` 传给 PowerShell wrapper，只传 `-UseRandom 1`。
- 新增 `lib/audio/indextts2-service.ts` 和 `app/api/projects/[projectId]/audio/indextts2/route.ts`。
- 新增 `lib/audio/indextts2-client.ts` 与 `lib/audio/use-indextts2.ts`。
- `components/create-flow/voice-chamber.tsx` 已接入语速、情绪强度、情绪提示、随机种子，并提交到后端 API。

## Verification

- `pnpm test`
- `pnpm vitest run lib\audio\indextts2-adapter.test.ts scripts\indextts2-smoke-preflight.test.mjs`
- `pnpm vitest run lib/audio/voice-generation.test.ts lib/audio/indextts2-adapter.test.ts lib/audio/indextts2-service.test.ts components/create-flow/voice-chamber.test.tsx scripts/indextts2-smoke-preflight.test.mjs`
- `pnpm smoke:indextts2`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- 已删除 `test-results`
