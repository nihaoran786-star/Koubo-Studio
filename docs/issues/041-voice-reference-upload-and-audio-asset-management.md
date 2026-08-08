# Issue 041 - 声音参考音频上传与 Audio Asset 管理

## What to build

把声音页里的 `files/reference-upload.wav`、`files/emotion-reference.wav` 等占位路径替换为真实上传/录音资产。用户需要能上传声音参考音频和情绪参考音频，文件进入当前项目 workspace，并作为 IndexTTS2 参数传给后端 adapter。

## User pain

Issue 040 已经让 adapter 能调用本地 IndexTTS2 runtime，但声音页仍没有真实上传入口。没有真实参考音频资产，IndexTTS2 只能返回配置或文件缺失错误，无法完成用户要求的声音克隆工作流。

## Architecture boundary

- UI：只负责选择文件、显示上传状态和已选资产，不直接写文件系统。
- Hook/client：提交文件和读取 asset 状态。
- Route：校验 project/session、文件类型、大小、MIME、用途，返回标准 `status/source/error`。
- Module interface：定义 `AudioAsset`、`AudioAssetPurpose`、`AudioAssetStatus`。
- Adapter：唯一负责把上传文件写入 workspace `files/audio`，并防止路径逃逸。
- IndexTTS2：只接收已登记的 workspace asset path，不接收 UI 拼接的临时路径。

## Acceptance criteria

- [x] 新增 audio asset 类型和索引，记录 reference/emotion/reference-recording 等用途。
- [x] 新增上传 API，支持 wav/mp3/m4a，限制大小和文件名，输出标准错误。
- [x] 声音页上传音频时写入当前项目 workspace，而不是使用占位路径。
- [x] 情绪参考音频有独立上传入口，并映射到 `emotionReferenceAudioPath`。
- [x] 录音模式至少保留明确状态；如果浏览器录音未实现，需要返回 `not_supported` 而不是伪造文件。
- [x] IndexTTS2 参数提交时使用已登记 asset path。
- [x] 单测覆盖文件校验、路径保护、asset index、client/hook 映射。
- [x] E2E 覆盖上传 reference/emotion 音频后提交生成请求。
- [x] 成功后删除测试产物。

## Blocked by

- Issue 040

## Notes

这个 issue 不要求生成高质量音频，只负责让前端真实提供参考音频资产。音质评估、长文本分段和批量音频生成继续后移。

## Progress

- 新增 `lib/audio/audio-asset.ts`，管理 workspace `files/audio` 下的上传音频资产和 `index.json`。
- 新增 `app/api/projects/[projectId]/audio-assets/route.ts`，支持 `reference`、`emotion`、`recording` 用途的音频上传。
- 新增 `lib/audio/audio-asset-client.ts` 和 `lib/audio/use-audio-asset-upload.ts`。
- `components/create-flow/voice-chamber.tsx` 已接入声音参考音频和情绪参考音频上传，并在 IndexTTS2 请求中使用 asset `relativePath`。
- 录音模式不会伪造文件；当前返回明确的未支持文案。

## Verification

- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- 已删除 `test-results`

## Residual risk

- `pnpm build` 通过，但 Turbopack 对 runtime workspace 文件写入仍有 NFT tracing warning。当前不影响功能；后续可在部署/打包阶段针对 Next tracing 进一步收敛。
