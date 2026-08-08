# Issue 011 - 设置页与多模型接入

## What to build

新增设置页，支持 OpenAI、本地 OpenAI-compatible endpoint、本地模型服务等 Provider 配置，并能测试连接状态。

## User pain

标题栏齿轮现在打开设备检测，不是设置。用户无法配置 OpenAI API Key、本地模型地址、默认模型、云端/本地优先级，也不知道当前请求会发到哪里。

## Acceptance criteria

- [ ] 顶部导航有明确“设置”入口。
- [ ] 设置页支持 Provider 列表：OpenAI、本地模型、自定义 OpenAI-compatible。
- [ ] 每个 Provider 可配置 base URL、API Key、模型名、启用状态和默认用途。
- [ ] 支持连接测试，状态包含未配置、测试中、已连接、失败。
- [ ] 设置页明确标注数据是否会离开本机。

## Blocked by

- Issue 005
