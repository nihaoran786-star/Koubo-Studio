# Issue 018 - 后期剪辑后端接入

## What to build

把视频剪辑能力包装成后期处理 adapter。它消费 HeyGem 输出视频、脚本文案、字幕信息和音频元数据，生成发布前成片或发布包素材。

## User pain

HeyGem 输出通常不是最终发布包。用户还需要字幕、音量处理、片头片尾、平台文案、封面或基础剪辑整理。如果没有后期 adapter，生产链路会停在未整理的视频文件。

## Acceptance criteria

- [ ] 后期阶段要求已有 render artifact。
- [ ] 后端可以消费脚本正文、caption、tags、audio duration、render video。
- [ ] 支持生成带字幕或字幕元数据的成片。
- [ ] 支持基础音视频 mux、音量检查或后续约定的轻处理能力。
- [ ] 输出 final video artifact 和 publish package artifact。
- [ ] 失败状态区分 missing input、unsupported format、adapter failed、output path error。
- [ ] UI 不直接操作 ffmpeg、剪辑脚本或文件路径。
- [ ] 如果当前 skill folder 尚无稳定剪辑 runtime，先实现 adapter contract 和 mock/fake 后端。

## Blocked by

- Issue 017
- 项目 artifact contract

