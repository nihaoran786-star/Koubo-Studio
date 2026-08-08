# Issue 026 - HeyGem 轻量数字人系统接入

## What to build

以轻量化目标接入 HeyGem 或 HeyGem-compatible 后端，只接入数字人口播生成所需的最小能力，同时尽量保证生成效果。

## User pain

没有真实数字人生成，项目只能停留在文案和音频。用户需要从 approved audio 和 avatar 素材生成可预览数字人口播视频。

## Acceptance criteria

- [ ] 明确 HeyGem-compatible 后端版本或 wrapper。
- [ ] 支持健康检查。
- [ ] 支持提交生成任务。
- [ ] 支持查询 queued/running/done/failed。
- [ ] 支持保存 render artifact。
- [ ] 支持预览输出视频。
- [ ] 不接入非必须代码和重型训练流程。
- [ ] 失败时明确区分 runtime unavailable、missing audio、missing avatar、generation failed。

## Blocked by

- Issue 017
- Issue 025

