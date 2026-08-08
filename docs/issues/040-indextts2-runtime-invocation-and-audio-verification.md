# Issue 040 - IndexTTS2 Runtime 调用与音频文件校验

## What to build

把 Issue 039 中的 IndexTTS2 adapter 从占位边界推进到真实本地 runtime 调用。adapter 需要读取配置的 IndexTTS2 runtime 路径，调用本地 Python/PowerShell 生成 WAV/MP3，并校验输出文件存在、时长有效、路径仍在当前 workspace artifact 范围内。

## User pain

Issue 039 已经打通参数、API、artifact 和前端提交状态，但默认 adapter 仍返回 `runtime_missing`。用户要求 IndexTTS2 是真实代码工作流，所以必须让后端能实际生成音频文件，而不是只保存参数。

## Architecture boundary

- UI：只显示配置缺失、生成中、成功和失败状态，不拼接本地命令。
- Route/service：只调用 adapter，不直接启动子进程。
- Adapter：唯一负责读取 runtime 配置、组装命令、启动 Python/PowerShell、校验输出文件。
- Workspace：所有输出必须写入 `artifacts/audio`，禁止任意路径写入。
- External system：本地 IndexTTS2 runtime，默认建议 ASCII 路径，例如 `C:\codex-indextts-test\IndexTTS`。

## Acceptance criteria

- [x] 新增 IndexTTS2 runtime 配置读取，支持环境变量和后续设置页接入。
- [x] adapter 调用本地 runtime 生成音频，参数覆盖 speed、emotionText、emotionAlpha、referenceAudio、emotionReferenceAudio、seed/useRandom、output format。
- [x] 子进程超时、退出码、stderr、缺依赖、缺模型权重分别返回 typed error。
- [x] 校验输出文件存在，且路径位于当前 workspace `artifacts/audio` 内。
- [x] 用 ffprobe 或等价方式读取 duration，写入 audio artifact。
- [x] 单测覆盖命令构造、错误分类、输出路径保护。
- [x] 在 runtime 不存在时，E2E 覆盖用户可见配置缺失状态。
- [x] 如果本机 runtime 可用，增加手动验证记录或可跳过的集成测试。
- [x] 成功后删除测试产物。

## Blocked by

- Issue 039

## Notes

这个 issue 仍不处理 HeyGem 口型同步，也不做长文本分段。长音频分段、批量生成和更细的音质评估进入后续 issue。

## Progress

- `lib/audio/indextts2-adapter.ts` 已实现环境变量配置读取、PowerShell 命令构造、子进程执行、错误分类、输出路径保护和 ffprobe duration 读取。
- `skills/natural-tts-voice-cloning/scripts/Invoke-NaturalTTS.ps1` 已补充 `Speed`、`EmotionReferenceAudio`、`Seed`、`UseRandom` 参数，并用 ffmpeg `atempo` 做语速处理。
- `skills/natural-tts-voice-cloning/scripts/natural_tts.py` 已补充 seed/useRandom/emotion reference 传递。emotion reference 会根据本地 IndexTTS2 `infer` 签名做兼容传参。
- 新增 `lib/audio/indextts2-adapter.integration.test.ts`，默认跳过；设置 `RUN_INDEXTTS2_INTEGRATION=1` 和 `INDEXTTS2_REFERENCE_AUDIO` 后可真实调用本地 runtime。
- 本机已临时启用 `RUN_INDEXTTS2_INTEGRATION=1` 跑通 `pnpm smoke:indextts2`。preflight 识别到真实 runtime root，integration smoke 通过 `generateIndexTTS2Audio()` 创建 approved script artifact、复制参考音频到 workspace、调用 IndexTTS2 runtime，并写入 ready audio artifact。
- 2026-06-13 复跑 `pnpm smoke:indextts2` 通过。preflight 识别到 `C:\koubo-runtimes\indextts2\IndexTTS`，integration smoke 1 个测试通过，耗时约 51.48 秒；运行后未留下固定 smoke workspace、`test-results`、`playwright-report` 或 `koubo-agent-*.log`。

## Verification

- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- PowerShell 脚本解析检查通过。
- Python wrapper `py_compile` 通过。
- `$env:RUN_INDEXTTS2_INTEGRATION='1'; pnpm smoke:indextts2`
- 已删除 `test-results` 和 Python `__pycache__`。
