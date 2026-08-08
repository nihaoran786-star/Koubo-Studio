# Issue 074 - Audio Requires Approved Script Artifact

Status: Done

## What to build

让 IndexTTS2 音频生成后端强制要求请求携带已确认的 `script` artifact。声音页可以传入正文文本用于生成，但后端必须用 `scriptArtifactId` 读取 workspace artifact，并确认 `approvalStatus` 是 `approved` 后才允许调用 IndexTTS2 adapter。

## User pain

Issue 072/073 已经让前端和 script artifact 都具备“确认文案”状态，但音频 API 仍可能被直接调用。如果后端不校验 artifact，草稿或伪造文本仍可能进入声音克隆、数字人、后期和发布链路。

## Architecture boundary

- UI：只把当前 script artifact id 随音频参数提交，不读取文件，不判断 artifact 内容。
- Hook/client：保持请求转发和状态映射。
- Route：只解析 `sessionId` 和 `parameters`，不做 artifact 业务判断。
- Service：唯一负责读取 script artifact、检查 `approvalStatus`，并决定是否调用 adapter。
- Adapter：只负责 IndexTTS2 runtime 调用和音频输出校验。

## Acceptance criteria

- [x] 音频参数支持携带 `scriptArtifactId`。
- [x] 声音页提交音频生成时传入当前文案 artifact id。
- [x] `generateIndexTTS2Audio()` 在调用 adapter 前读取 script artifact。
- [x] script artifact 缺失时返回 typed `invalid_request/script_artifact_missing`。
- [x] script artifact 仍是 `draft` 时返回 typed `invalid_request/script_not_approved`。
- [x] 缺失或 draft 状态不会调用 IndexTTS2 adapter。
- [x] 单测覆盖 approved、missing、draft 三条 service 路径。
- [x] E2E mock 断言声音页请求带有 `scriptArtifactId`。

## Implementation notes

- `VoiceGenerationParameters` 新增兼容字段 `scriptArtifactId`；运行时规范化仍要求请求必须提供非空值。
- `lib/audio/indextts2-service.ts` 使用 `getScriptArtifact()` 做后端 gate。
- `components/create-flow/create-flow-app.tsx` 向声音页传入 `activeProject.script.artifactId`。
- `components/create-flow/voice-chamber.tsx` 把 `scriptArtifactId` 放入音频生成参数。

## Verification

- `pnpm vitest run lib/audio/voice-generation.test.ts lib/audio/indextts2-service.test.ts lib/audio/indextts2-client.test.ts lib/audio/use-indextts2.test.tsx lib/audio/indextts2-route-handler.test.ts`
- `pnpm typecheck`

## Blocked by

- Issue 073
