# Issue 025 - IndexTTS2 前端参数映射与音频工作流

## What to build

在音频页面接入 IndexTTS2 代码工作流，保留当前设计风格，并映射声音克隆与音频生成需要的关键参数。

## User pain

用户需要调整语速、情绪、情绪参考音频、参考声音等参数，但当前音频页面没有真实后端，也没有参数映射。

## Acceptance criteria

- [x] 支持上传或选择 reference audio。
- [x] 支持语速调节。
- [x] 支持 emotion text。
- [x] 支持 emotion alpha / 情绪强度。
- [x] 支持 emotion reference audio 上传。
- [x] 支持生成 8-12 秒测试音频。
- [x] 支持生成完整口播音频。
- [x] 输出 audio artifact。
- [x] UI 保留当前整体视觉风格。
- [x] 缺 runtime、路径错误、参考音频错误、合成失败都有明确状态。

## Blocked by

- Issue 016
- Issue 024

## Progress

- 声音页已接入真实 audio asset 上传，reference/emotion 音频进入 workspace 后作为 IndexTTS2 参数提交。
- 声音页已映射 `speed`、`emotionText`、`emotionAlpha`、`emotionReferenceAudioPath`、`seed/useRandom`、`outputFormat`。
- 新增“先生成 10 秒测试音频”开关，提交 `trimSeconds: 10`，完整口播默认不传 `trimSeconds`。
- Adapter 已把 `trimSeconds` 映射为 PowerShell `-TrimSeconds`。
- 单测和 Playwright 覆盖参数从 UI/client/service 到 adapter 的传递。
- `VoiceChamber` 单测已锁定 UI 到生成参数的完整映射：reference audio、`speed`、`emotionText`、`emotionAlpha`、emotion reference audio、`seed/useRandom`、`trimSeconds`、`outputFormat`。
- 2026-06-12：收紧随机种子语义。`useRandom=true` 时 service 参数归一化会清空固定 `seed`，adapter 也不会向 PowerShell wrapper 传 `-Seed`，避免同时提交 `-Seed` 与 `-UseRandom 1` 的冲突入参。真实 `pnpm smoke:indextts2` 复跑通过。
- 2026-06-13：复跑真实 `pnpm smoke:indextts2` 通过。preflight 识别到 `C:\koubo-runtimes\indextts2\IndexTTS`，integration smoke 1 个测试通过，耗时约 51.48 秒；固定 smoke workspace 和测试产物已清理。

## Verification

```powershell
pnpm vitest run lib/audio/voice-generation.test.ts lib/audio/indextts2-adapter.test.ts lib/audio/indextts2-service.test.ts lib/audio/indextts2-client.test.ts lib/audio/use-indextts2.test.tsx
pnpm typecheck
pnpm test:e2e -- tests/e2e/script-page.spec.ts -g "voice page submits IndexTTS2 parameters"
pnpm smoke:indextts2
```
