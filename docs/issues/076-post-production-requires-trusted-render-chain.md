# Issue 076 - Post-production Requires Trusted Render Chain

Status: Done

## What to build

让后期剪辑智能体只消费可信的上游 render 链路。`post-production` service 在调用视频剪辑 skill 前，必须确认 render artifact 是 `ready`，对应 script artifact 已 `approved`，render 关联的 audio artifact 本身是 `ready`，并且 audio artifact 来自同一个 script。

## User pain

Issue 075 已经让 HeyGem 生成只接收已确认文案和匹配音频，但后期剪辑 service 仍可能在缺失 script、旧音频或失败 render 的情况下调用 skill。这样会浪费本地剪辑运行时，也会生成无法追溯的发布素材。

## Architecture boundary

- UI：只提交 `renderArtifactId` 和剪辑参数。
- Route：只解析请求体和 `sessionId`。
- Service：读取 render/script/audio artifact，并执行 readiness、approval 和上游关联校验。
- Skill runner：只接收已校验的 render 视频、script 文本和输出路径。

## Acceptance criteria

- [x] render artifact 缺失或非 `ready` 时不调用剪辑 skill。
- [x] render 关联的 script artifact 缺失时不调用剪辑 skill。
- [x] script artifact 仍是 `draft` 时返回 `invalid_request/script_not_approved`。
- [x] render 关联的 audio artifact 缺失时不调用剪辑 skill。
- [x] render 关联的 audio artifact 非 `ready` 时不调用剪辑 skill。
- [x] audio artifact 的 `parameters.scriptArtifactId` 与 render script 不匹配时返回 `invalid_request/audio_script_mismatch`。
- [x] happy path 仍把 script 正文传给 skill runner。
- [x] 单测覆盖 ready、failed render、draft script、audio mismatch 和 skill failure。

## Implementation notes

- `lib/post-production/post-production-agent-service.ts` 新增 audio artifact 读取和上游链路校验。
- 2026-06-12：补齐 ready audio gate。历史坏数据或失败音频 artifact 即使被 ready render 引用，后期 service 也会返回 `invalid_request/audio_artifact_not_ready`，不会调用剪辑 skill。
- service 不再用空字符串替代缺失 script 文本；缺失 script 会成为 typed invalid request。
- `lib/post-production/post-production-agent-service.test.ts` 的种子数据补齐 audio artifact，并新增失败路径断言。

## Verification

- `pnpm vitest run lib/post-production/post-production-agent-service.test.ts`
- `pnpm vitest run lib/post-production/post-production-agent-service.test.ts lib/post-production/video-editing-skill-runner.test.ts lib/post-production/post-production-agent-route-handler.test.ts lib/post-production/post-production-agent-client.test.ts`
- `pnpm smoke:post-production-local-skill`
- `pnpm typecheck`

## Blocked by

- Issue 075
