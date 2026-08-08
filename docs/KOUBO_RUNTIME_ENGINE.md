# KouboRuntime 数字人引擎决策

更新时间：2026-07-17

## 决策

产品的数字人主引擎保持为项目最初接入并已完成真实链路验证的
Duix/HeyGem。

```text
数字人页面
→ digital-human service
→ HeyGem adapter
→ duix_face2face 或 managed_wsl compatible_render
→ HeyGem Linux/Python runtime
```

已有 UI、workspace 项目状态、任务恢复、结果校验和媒体读取继续以
`lib/digital-human/heygem-adapter.ts` 为唯一 adapter 边界。WSL2 只负责承载
免 Docker 的 HeyGem runtime，不改变页面公共输入，也不让页面感知模型路径或
Linux 进程。

## 运行模式

- 已配置的本机或远程 HeyGem/Duix 服务继续使用 `duix_face2face`：
  `POST /easy/submit`、`GET /easy/query` 和显式结果目录。
- App 管理的 WSL2 `KouboRuntime` 使用固定 loopback
  `compatible_render`：`GET /health`、`POST /render`。
- WSL 内的兼容服务负责把 `/render` 转换为 HeyGem Python 推理调用；主 App
  继续负责 workspace 路径门禁、候选产物、ffprobe、同步和原子发布。
- 模型按任务加载或在空闲后释放，不能随主 App 常驻占用 GPU。

## 分发边界

HeyGem Linux/Python Hack 仓库明确说明其中 `.so` 和模型来自硅基，并仅将
License 指向 HeyGem.ai 协议。技术上可运行不等于可以随免费 App 重新分发。

在取得完整授权证据前：

- 主 App 不内置 HeyGem 模型、专有 `.so` 或第三方 Docker 镜像。
- 安装流程只接受用户主动选择的本地运行包，或使用经发布者明确授权的下载源。
- 不能把未经授权的第三方资产上传到本项目自己的 CDN 后一键下载。
- 项目可以继续连接用户已有的 HeyGem/Duix 服务，并提供 WSL 环境检查、导入、
  启停、卸载和故障恢复。

这是一项工程分发决策，不替代发布者的正式法律审查。
