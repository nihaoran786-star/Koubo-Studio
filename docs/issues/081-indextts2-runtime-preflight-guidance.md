# Issue 081 - IndexTTS2 Runtime Preflight Guidance

Status: Done

## What to build

给 `pnpm smoke:indextts2` 增加真实 runtime 前置检查。默认不触碰本地模型；只有设置 `RUN_INDEXTTS2_INTEGRATION=1` 后，才校验 `INDEXTTS2_RUNTIME_ROOT`、`INDEXTTS2_REFERENCE_AUDIO`、PowerShell wrapper 参数契约、`natural_tts.py`、Python venv、`checkpoints/config.yaml`、ffmpeg 和 ffprobe。

## User pain

Issue 080 已经让 IndexTTS2 smoke 走 service-level artifact 链路，但如果本地 runtime 缺依赖，用户仍会直接看到模型进程失败。真实声音克隆排障需要在启动模型前指出缺失路径和修复方式。

## Architecture boundary

- Preflight script：只检查环境变量、文件路径、runtime 目录和系统依赖。
- Integration smoke：创建 approved script artifact，并通过 `generateIndexTTS2Audio()` 执行。
- Service：继续负责 `scriptArtifactId` gate 和 audio artifact 写入。
- Adapter：继续负责 PowerShell/IndexTTS2 runtime 调用和输出校验。
- UI：不参与 runtime smoke。

## Acceptance criteria

- [x] 未设置 `RUN_INDEXTTS2_INTEGRATION=1` 时默认跳过并输出提示。
- [x] 启用后缺 `INDEXTTS2_REFERENCE_AUDIO` 时返回可操作错误。
- [x] 启用后缺 `INDEXTTS2_RUNTIME_ROOT` 时返回可操作错误。
- [x] 校验 runtime root 下的 `IndexTTS` 目录。
- [x] 校验 `IndexTTS/.venv/Scripts/python.exe`。
- [x] 校验 `INDEXTTS2_SCRIPT_PATH` 或默认 PowerShell wrapper。
- [x] 校验 wrapper 同目录的 `natural_tts.py`。
- [x] 校验 `IndexTTS/checkpoints/config.yaml`。
- [x] 对缺少明显权重文件给出 warning，不误杀非标准 checkpoint 布局。
- [x] 校验 ffmpeg 和 ffprobe 可用。
- [x] 校验 PowerShell wrapper 接受 app adapter 传入的参数，缺失时返回 `wrapper_parameter_mismatch`。
- [x] `pnpm smoke:indextts2` 先执行 preflight，再执行 integration smoke。

## Implementation notes

- 新增 `scripts/indextts2-smoke-preflight.mjs`。
- 新增 `scripts/indextts2-smoke-preflight.test.mjs`。
- `package.json` 的 `smoke:indextts2` 改为 `node scripts/indextts2-smoke-preflight.mjs && vitest run ...`。
- PowerShell wrapper 参数契约当前要求：`ReferenceAudio`、`Text`、`Output`、`OutputFormat`、`RuntimeRoot`、`EmotionText`、`EmotionAlpha`、`Speed`、`EmotionReferenceAudio`、`Seed`、`UseRandom`、`TrimSeconds`。
- `generateIndexTTS2Audio()` 在调用 adapter 前会用 ffprobe probe 用户上传的声音参考音频和情绪参考音频；不可读取有效时长时返回 `reference_audio_probe_failed` 或 `emotion_reference_audio_probe_failed`，不启动真实 IndexTTS2 长任务。

## Verification

- `pnpm vitest run scripts/indextts2-smoke-preflight.test.mjs`
- `pnpm vitest run lib/audio/indextts2-service.test.ts`
- `pnpm smoke:indextts2`

Latest verified command:

```text
RUN_INDEXTTS2_INTEGRATION=1 pnpm smoke:indextts2
IndexTTS2 runtime preflight passed: C:\koubo-runtimes\indextts2\IndexTTS
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    134.63s
```

## Blocked by

- Issue 080
