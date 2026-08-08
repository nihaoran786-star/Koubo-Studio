# Issue 019 - 数字人生产链路 Artifact Contract

## What to build

定义数字人生产链路中 script、audio、render、post-production、publish package 的 artifact contract。所有阶段通过 artifact contract 传递数据，不通过页面组件临时拼路径或读取底层 session 文件。

## User pain

如果每个阶段都自己决定文件名、路径、状态和错误格式，后续接入 IndexTTS2、HeyGem、剪辑后端时会很快失控。需要先有统一 artifact contract，保证每一步可以单独测试、重试、替换后端。

## Acceptance criteria

- [ ] 定义 script artifact 字段：title、hook、body、caption、tags、duration、voiceNotes、shotNotes、riskNotes。
- [ ] 定义 audio artifact 字段：source script ID、reference audio、output path、duration、probe/full generation type。
- [ ] 定义 render artifact 字段：source audio ID、avatar config、output video path、preview path、duration。
- [ ] 定义 post-production artifact 字段：source render ID、subtitle metadata、final output path、warnings。
- [ ] 定义 publish package artifact 字段：final video、title、caption、tags、platform notes、risk notes。
- [ ] 所有 artifact 路径必须留在当前 project workspace 内。
- [ ] 所有阶段状态复用 `idle`、`needs_input`、`queued`、`running`、`done`、`failed`、`blocked`。
- [ ] 所有 adapter 返回 `status/source/error.code/error.message`。

## Blocked by

- Issue 005
- Issue 006
