# Koubo Studio（口播智能体）

一个 local-first 的 Windows 数字人口播制作应用。它把文案、声音、数字人、本地剪辑和浏览器辅助发布串成一条简单的五步工作流。

```text
AI 对话生成文案
→ 选择音色或克隆声音
→ 选择形象或上传素材生成数字人视频
→ 本地简单剪辑或 AI Agent 精剪
→ 打开可见浏览器辅助发布
```

项目正处于删除式轻量化阶段：保留真实的本地生成与媒体处理能力，删除旧外部发布系统、假素材入口和过度验收底座。当前事实与边界以 [`docs/CONTEXT.md`](docs/CONTEXT.md) 为准。

## 上游资产与学习使用声明

本仓库公开的是 Koubo Studio 的应用源码，供学习、研究和开发参考；不随仓库或 Release 提供任何上游数字人模型、模型权重、`.so`、CUDA 组件、Docker 镜像或 WSL rootfs。

- 数字人适配层参考 DUIX.COM 与 HeyGem 生态的公开接口；每位使用者必须自行从上游取得所需资产，并遵守对应许可、NOTICE、归属和适用法律。
- 不能因为项目免费、非商业或“仅供学习”而镜像、转存或重新打包上游模型与二进制。
- 若使用 DUIX.COM Materials，须遵守其 Community License 的协议副本、`Built with DUIX.COM` 展示和 NOTICE 等要求；详见 [`NOTICE`](NOTICE) 与 [`docs/KOUBO_RUNTIME_DISTRIBUTION.md`](docs/KOUBO_RUNTIME_DISTRIBUTION.md)。

## 产品原则

- local-first：项目、素材、中间产物和成片默认保存在本机。
- 真实能力优先：界面只展示有真实素材或 runtime 支撑的功能。
- 主 App 轻量：GPU 模型、Docker 和远程生成服务都是可选 runtime。
- 单一项目状态：五阶段状态和产物引用由本地创作项目统一管理。
- 可见发布：平台登录、验证码和最终提交由用户监督，应用不保存平台密码。

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 桌面端 | Tauri 2（Windows） |
| Web UI / 本地后端 | Next.js 16（App Router） |
| UI 运行时 | React 19 + TypeScript |
| 样式 | Tailwind CSS v4 |
| AI 对话 | 原生 OpenAI-compatible HTTP adapter + 可配置 AI Provider |
| 声音 | IndexTTS2 adapter |
| 数字人 | Duix/HeyGem adapter |
| 本地剪辑 | ffmpeg / ffprobe |
| 测试 | Vitest + Playwright |

## 环境要求

- Windows
- Node.js `>= 22.19.0`
- pnpm
- 构建桌面包时需要 Rust 和 Tauri 的 Windows 前置环境
- 使用本地剪辑时需要 ffmpeg 和 ffprobe
- 使用声音或数字人生成时，需要准备对应的本机或远程 runtime

## 快速开始

```powershell
pnpm install
pnpm dev
```

开发服务器启动后，根据终端输出打开本机地址。桌面开发模式：

```powershell
pnpm desktop:dev
```

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

构建 Windows 桌面应用：

```powershell
pnpm desktop:build
```

桌面构建会准备 Next standalone 本地后端并由 Tauri 管理其生命周期。真实 runtime 未配置时，对应生成步骤应返回明确的缺失状态和恢复建议，而不是静默失败。

## 目标模块

```text
UI
→ hook / API client
→ API route
→ module service
→ adapter
→ local or remote runtime
```

- 文案：AI 对话、文案版本和确认。
- 声音：本地音色库、参考音频、IndexTTS2 任务和音频结果。
- 数字人：本地形象库、Duix/HeyGem 任务和视频结果。
- 剪辑：字幕、画幅、音量、背景音乐、片头片尾、封面和 MP4 导出。
- 发布：发布文案与素材包、抖音和小红书可见浏览器 adapter。
- workspace：项目隔离、路径安全、素材、产物和失败恢复。

## 本地数据

创作数据默认位于：

```text
%APPDATA%/com.koubo.agent/workspaces/<projectId>/
```

运行时密钥、本机路径、平台账号信息和生成素材不得提交到仓库。应用不保存平台密码；浏览器发布中的登录、扫码、验证码、风控和最终提交需要用户监督。

## 当前建设重点

1. 删除旧外部发布系统及其残留，不保留兼容层。
2. 统一五阶段创作项目状态。
3. 建立真实本地音色库和形象库。
4. 做实 ffmpeg 字幕与简单剪辑，并让 Agent 精剪复用同一执行核心。
5. 优化五步 UI、错误恢复和性能。
6. 最后实现抖音、小红书可见浏览器发布自动化；真实最终提交由用户监督。

详细设计约束、已具备能力和待实现范围见 [`docs/CONTEXT.md`](docs/CONTEXT.md)。
