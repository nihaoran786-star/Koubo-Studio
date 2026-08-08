# Issue 014 - 桌面安全、隐私与运行文档

## What to build

修正桌面应用安全边界和运行说明。生产桌面版不能继续关闭 CSP，也不能让用户误以为所有数据永远只在本机。

## User pain

后续一旦接入 OpenAI、本地模型 Web UI、第三方素材或文件系统权限，关闭 CSP 会放大风险。README 仍说纯前端 mock，包名还是 `my-project`，桌面启动和依赖说明不完整。

## Acceptance criteria

- [ ] 桌面生产构建启用明确 CSP，只允许必要资源和 API 域名。
- [ ] 桌面版默认禁用或明确说明 Analytics。
- [ ] README 区分 Web 预览和 Windows 桌面运行方式。
- [ ] README 说明 Rust、Tauri、WebView2、FFmpeg、本地模型依赖。
- [ ] 包名、产品名和文档表述一致。
- [ ] 设置页或首次启动说明本地处理、云端处理和遥测状态。

## Blocked by

- Issue 011
