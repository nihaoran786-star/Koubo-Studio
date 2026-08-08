# Issue 012 - 真实设备检测与降级建议

## What to build

把设备检测从动画改成真实能力检查。用户应该看到本机是否具备 FFmpeg、CUDA/GPU、本地模型服务和必要运行环境。

## User pain

当前没有 GPU、CUDA 或 FFmpeg 的用户也会看到 `Local Ready` 和“本地标准模式”，真正生成时才会失败，信任感会直接崩。

## Acceptance criteria

- [ ] 检测状态使用明确模型：unknown / checking / available / missing / error。
- [ ] 至少检测 FFmpeg 是否可用。
- [ ] 本地模型服务用 endpoint 连通性检测，不用动画假装成功。
- [ ] 缺失能力时给安装/配置建议和降级方案。
- [ ] 检测结果能影响声音、数字人、渲染步骤的推荐模式。

## Blocked by

- Issue 011
