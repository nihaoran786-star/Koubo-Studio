# Issue 075 - HeyGem Requires Approved Script and Matching Audio

Status: Done

## What to build

让 HeyGem 数字人生成后端只消费可信的上游 artifact：`script` artifact 必须已经 `approved`，并且 `audio` artifact 必须来自同一个 `scriptArtifactId`。如果用户绕过前端步骤或使用过期音频，service 应在调用 HeyGem adapter 前拒绝请求。

## User pain

Issue 074 已经阻止未确认文案进入 IndexTTS2，但数字人 API 仍只检查 script/audio artifact 是否存在。如果旧音频或草稿文案被直接传给 HeyGem，后续 render、后期剪辑和发布都会继承错误输入。

## Architecture boundary

- UI：只传 `scriptArtifactId` 和 `audioArtifactId`，不读取 artifact 文件。
- Route：只校验请求形状和 `sessionId`。
- Service：唯一读取 script/audio artifact，并校验 approval 与 artifact 关联关系。
- Adapter：只接收已校验 artifact，负责 HeyGem runtime/API 调用和输出视频校验。

## Acceptance criteria

- [x] `generateHeyGemRender()` 在调用 adapter 前确认 script artifact 存在。
- [x] script artifact 为 `draft` 时返回 `invalid_request/script_not_approved`。
- [x] audio artifact 缺失时仍返回 `invalid_request/missing_audio_artifact`。
- [x] audio artifact 的 `parameters.scriptArtifactId` 不匹配当前 script 时返回 `invalid_request/audio_script_mismatch`。
- [x] draft 或不匹配输入不会调用 HeyGem adapter。
- [x] 单测覆盖 approved、missing、draft、audio mismatch 路径。

## Implementation notes

- `lib/digital-human/heygem-service.ts` 新增 approved script gate。
- 同一 service 中新增 audio/script 关联校验，避免旧音频复用到新文案。
- `lib/digital-human/heygem-service.test.ts` 补充 draft 和 mismatch 用例。

## Verification

- `pnpm vitest run lib/digital-human/heygem-service.test.ts`
- `pnpm typecheck`

## Blocked by

- Issue 074
