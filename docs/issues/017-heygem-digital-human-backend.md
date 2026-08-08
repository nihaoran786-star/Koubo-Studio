# Issue 017 - HeyGem 数字人生成后端接入

## What to build

把 HeyGem 或 HeyGem-compatible 后端包装成数字人生成 adapter。它消费 approved audio artifact、数字人素材或 avatar 配置，生成数字人口播视频，并保存为项目 render artifact。

## User pain

当前数字人步骤只有 UI 原型，没有真实后端。用户即使完成文案和音频，也无法生成可预览的数字人口播视频。

## Acceptance criteria

- [ ] 数字人阶段要求已有 approved script 和 audio artifact。
- [ ] 后端可以检查 HeyGem 服务是否可用。
- [ ] 缺少 HeyGem runtime、服务未启动、缺少音频、缺少 avatar 素材时返回明确错误。
- [ ] 支持提交生成任务并返回 queued/running/done/failed 状态。
- [ ] 输出视频保存到当前项目 workspace。
- [ ] 返回 render artifact ID、视频路径、预览路径、时长、警告和错误信息。
- [ ] UI 只通过 API 查询任务状态，不直接调用 HeyGem。
- [ ] HeyGem 具体 API 契约在实现前需要锁定到一个版本或 wrapper。

## Blocked by

- Issue 016
- HeyGem-compatible 后端部署方式确认

