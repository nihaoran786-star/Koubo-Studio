# Issue 066 - Post-production Built-in Skill Smoke

Status: Done

## What to build

让后期剪辑智能体在没有显式 `scriptPath` 时，能通过内置 `builtin:post-production-cut-review` skill 调用项目自带 PowerShell workflow，使用 ffmpeg 生成后期成片、字幕和封面，并用本地 smoke 测试证明 artifact 链路真实可跑。

## User pain

045 已经建立后期页面、service、artifact 和 skill runner，但页面传入的是内置 skill id/name；如果 service 不把内置 skill 映射到真实脚本，用户点击后期智能体会失败为 `skill_script_missing`。这会让“数字人 -> 后期剪辑”链路停在 mock 能力上。

## Architecture boundary

- UI：只提交内置 skill id/name 和用户剪辑请求，不知道脚本路径。
- Service：识别内置 skill，补齐 bundled workflow 的 `scriptPath`。
- Adapter/runner：唯一负责执行 PowerShell、ffmpeg、ffprobe，并校验输出路径与文件。
- Artifact：保存 post-production ready/failed 结果，包括 output/subtitle/cover 和 typed error。
- External system：Windows PowerShell + ffmpeg/ffprobe。

## Acceptance criteria

- [x] `builtin:post-production-cut-review` 在缺少 `scriptPath` 时自动映射到 bundled workflow。
- [x] 显式传入的项目/用户 skill `scriptPath` 不被覆盖。
- [x] 内置 workflow 能接收 render 视频、文案、剪辑请求、比例、字幕风格和背景音乐参数。
- [x] workflow 生成 mp4、srt、png 三类输出文件。
- [x] smoke 默认跳过，避免普通测试误执行本地视频处理。
- [x] 设置 `RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE=1` 后可真实执行 ffmpeg 并保存 ready post-production artifact。
- [x] 输出路径仍限制在当前 workspace `artifacts/post-production`。
- [x] 后期 skill runner 会把 ffmpeg/ffprobe 缺失和无法读取的 render 视频归类为稳定错误码，避免泛化 `skill_failed`。

## Implementation notes

- 新增 `scripts/Invoke-BuiltinPostProductionSkill.ps1`，作为内置后期剪辑 workflow。当前版本做轻量 scale/pad、字幕文件生成和封面抽帧，不承担复杂自动剪辑决策。
- `lib/post-production/post-production-agent-service.ts` 增加内置 skill 解析：只有在没有显式 `scriptPath` 时才补 bundled workflow。
- `lib/post-production/video-editing-skill-runner.test.ts` 覆盖 PowerShell 参数构造。
- `lib/post-production/post-production-agent-service.test.ts` 覆盖内置 skill 映射与显式 `scriptPath` 保留。
- `lib/post-production/post-production-local-skill-smoke.integration.test.ts` 用 ffmpeg 生成短 render 输入，再跑完整 service/runner/workflow/artifact 链路。

## Verification

- `pnpm vitest run lib/post-production/video-editing-skill-runner.test.ts lib/post-production/post-production-agent-service.test.ts`
- `pnpm smoke:post-production-local-skill`
- `RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE=1 pnpm smoke:post-production-local-skill`

## Blocked by

- Issue 045

## Notes

这是后期剪辑真实化的最小可运行版本。后续如果接更复杂的视频剪辑 skill，应保持同一边界：页面不接触命令，service 只做 skill 选择和上下文构造，runner/adapter 执行外部 workflow。

## Latest runtime check

- 2026-06-12：临时设置 `RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE=1` 后运行 `pnpm smoke:post-production-local-skill` 通过。该 smoke 真实调用内置 PowerShell/ffmpeg workflow，并由测试清理 `post-production-local-skill-smoke` workspace。
- 2026-06-12：后期错误分类补强。`ffmpeg` 不可用会返回 `dependency_missing`，输入视频损坏/不可读取会返回 `input_video_invalid`。已运行 `pnpm vitest run lib/post-production/video-editing-skill-runner.test.ts lib/post-production/post-production-agent-service.test.ts components/create-flow/render-chamber.test.tsx`、`pnpm typecheck`、`pnpm smoke:post-production-local-skill`，全部通过。
- 2026-06-13：复跑 `$env:RUN_POST_PRODUCTION_LOCAL_SKILL_SMOKE='1'; pnpm smoke:post-production-local-skill` 通过。preflight 确认内置 PowerShell workflow 可用，integration smoke 真实调用 ffmpeg 生成 mp4/srt/png 并保存 ready post-production artifact；测试结束后固定 workspace `post-production-local-skill-smoke` 已清理。
