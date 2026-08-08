# Issue 042 - 生成音频试听、恢复与长文本分段

## What to build

让声音页真正使用生成后的 audio artifact：生成成功后可试听、可恢复最近一次音频、可把音频 artifact 传给数字人阶段。对较长文案，需要建立分段生成策略，避免一次性长文本导致 IndexTTS2 卡住或失败。

## User pain

Issue 041 已完成参考音频上传，但声音页生成成功后仍只是显示状态标签，没有真实试听控件，也没有从 workspace 恢复上次生成结果。用户无法确认声音是否可用，后续 HeyGem 也拿不到明确的最终音频输入。

## Architecture boundary

- UI：只播放已登记 audio artifact，不拼接任意本地路径。
- Hook/client：读取项目 audio artifact 列表和当前选中音频。
- Route/service：返回 audio artifact 元数据和可播放资源引用。
- Module interface：定义 `SelectedAudioArtifactState` 和长文本分段任务状态。
- Adapter：负责长文本拆分生成、合并、duration 校验和失败回滚。
- External system：IndexTTS2、ffmpeg/ffprobe。

## Acceptance criteria

- [x] 新增 audio artifact 查询 API，能返回最近一次 ready 音频。
- [x] 声音页生成成功后显示可试听控件和文件/时长信息。
- [x] 刷新或重新打开项目后能恢复最近一次 ready 音频状态。
- [x] 下一步进入数字人阶段时，项目状态能携带选中的 audio artifact id。
- [x] 长文本超过阈值时进入分段生成流程，而不是直接提交超长文本。
- [x] 分段失败时返回明确 `segment_failed`，并不污染 ready artifact。
- [x] 单测覆盖 artifact 查询、恢复状态、分段计划、失败回滚。
- [x] E2E 覆盖生成后试听状态和刷新恢复。
- [x] 成功后删除测试产物。

## Blocked by

- Issue 041

## Notes

这个 issue 仍属于 IndexTTS2 代码工作流，不引入后期剪辑智能体，也不接 HeyGem。

## Progress

- 新增 `lib/audio/audio-artifact-query.ts`，可查询最近一次 ready audio artifact，并返回播放引用。
- 新增 `app/api/projects/[projectId]/audio-artifacts/latest/route.ts` 和 `app/api/projects/[projectId]/audio-artifacts/[artifactId]/file/route.ts`。
- 新增 `lib/audio/audio-artifact-client.ts` 和 `lib/audio/use-latest-audio-artifact.ts`，声音页加载后会恢复最近一次 ready 音频。
- 新增 `lib/audio/audio-segmentation.ts`，提供长文本分段计划和 `segment_failed` 错误。
- `components/create-flow/voice-chamber.tsx` 生成成功后显示 artifact id、时长和试听控件；重新进入声音页时可从 latest API 恢复。

## Verification

- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- 已删除 `test-results`

## Residual risk

- 当前“下一步携带选中 audio artifact id”已在声音页状态层具备明确 selected artifact，但数字人阶段还未消费它。消费链路进入 Issue 043。
- Turbopack 仍对 runtime workspace 文件写入给出 NFT tracing warning；构建成功，后续打包阶段继续收敛。
