# 064 - IndexTTS2 Preview Trim Parameter

状态：Done

## What to build

补齐 IndexTTS2 声音页“测试音频”参数映射：用户可先生成约 10 秒测试音频，确认声音、语速和情绪后再生成完整口播音频。

## Why now

025/039/040/041 已经打通声音参考、情绪参考、语速、情绪文本和 audio artifact，但 025 仍有“生成 8-12 秒测试音频”验收项没有被参数契约证明。底层 `Invoke-NaturalTTS.ps1` 已支持 `TrimSeconds`，应用层需要把它纳入 UI/client/service/adapter 的可测链路。

## Acceptance criteria

- [x] `VoiceGenerationParameters` 支持 `trimSeconds`。
- [x] 参数校验限制 `trimSeconds` 在 0 到 600 秒之间。
- [x] 声音页保留当前视觉风格，新增“先生成 10 秒测试音频”开关。
- [x] 勾选测试音频时提交 `trimSeconds: 10`。
- [x] 不勾选时仍生成完整口播音频。
- [x] Adapter 把 `trimSeconds` 映射为 PowerShell `-TrimSeconds`。
- [x] Audio artifact 保存输入参数，便于恢复和后续数字人阶段追踪。
- [x] 单测覆盖 voice 参数、client、hook、service、adapter。
- [x] E2E 覆盖声音页勾选测试音频后提交 `trimSeconds`。

## Verification

```powershell
pnpm vitest run lib/audio/voice-generation.test.ts lib/audio/indextts2-adapter.test.ts lib/audio/indextts2-service.test.ts lib/audio/indextts2-client.test.ts lib/audio/use-indextts2.test.tsx
pnpm typecheck
pnpm test:e2e -- tests/e2e/script-page.spec.ts -g "voice page submits IndexTTS2 parameters"
```
