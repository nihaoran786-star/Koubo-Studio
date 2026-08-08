# KouboRuntime 免费分发策略

## 结论

技术上可以形成不含第三方数字人 runtime 的轻量、免 Docker App 包；数字人生成环境采用外置授权运行时包，不随 App 安装包分发。用户只需在设置页完成 WSL 检查并选择本地 `KouboRuntime.tar`，日常启动不会打开 Docker。作者公开发布前仍须为项目本体选择许可并补齐 LICENSE/NOTICE；第三方资产能否再分发由对应许可和授权决定。

这一区分解决的是两个不同问题：

```text
App 安装包
  = Tauri + 本地 Node backend
  = 技术上可构建不含第三方 runtime 的轻量包
  = 公开发布仍以项目本体 LICENSE/NOTICE 完整为前提

KouboRuntime
  = WSL rootfs + 推理代码 + 模型 + Linux/CUDA 组件
  = 必须逐项确认来源、许可证与再分发授权
```

## 当前允许的交付

- App 可以检查 Windows、WSL 2、GPU、显存、内存和磁盘，并在用户确认后调用 Windows 官方 WSL 安装流程。
- App 可以导入用户主动选择的 `.tar`，验证旁车 SHA-256、固定 manifest/controller 和真实 `/health`。
- App 可以连接用户已配置的本机或远程 HeyGem-compatible 服务。
- App 不自动下载、转换或打包 HeyGem/Duix/Hack 的模型、`.so`、Docker 镜像或 WSL rootfs。
- 桌面构建预检会递归扫描 `src-tauri/resources`；发现模型权重、`KouboRuntime` tar、明确 HeyGem/Duix runtime 目录或其中的 Linux `.so` 时，以 `desktop_bundle_contains_runtime_assets` 拒绝构建。普通 Node backend、Playwright core 和一般 Node 原生依赖不受该规则影响。

## 上游证据边界

以下是用于确定当前工程策略的上游文本摘要，不是法律意见：

1. [DUIX.COM Community License](https://raw.githubusercontent.com/duixcom/Duix-Avatar/main/LICENSE) 允许有限的使用、修改和再分发，但附带协议随附、`Built with DUIX.COM` 展示、用户协议披露和 NOTICE 等归属条件。当前许可证文本还以 1,000 月活为门槛要求申请商业许可；是否免费收费不改变该门槛。
2. [HeyGem-Linux-Python-Hack README](https://raw.githubusercontent.com/Holasyb918/HeyGem-Linux-Python-Hack/main/README.md) 说明 `.so` 与模型来自“硅基”，并将 License 指向/参考 HeyGem.ai 协议。其 [download.sh](https://raw.githubusercontent.com/Holasyb918/HeyGem-Linux-Python-Hack/main/download.sh) 从 Release 下载多类模型权重。当前公开材料不足以作为本项目重新打包这些资产的完整授权记录。

因此，“代码能运行”和“资产可以随免费 App 再分发”必须分开验收。未获证据支持的资产不会进入安装包，也不会被一键下载。

## 已选择的运行引擎

`KouboRuntime` 保持使用项目原始的 Duix/HeyGem 生成链路。WSL2 运行包的目标是让
HeyGem Linux/Python runtime 无需 Docker 地运行，并通过现有 adapter 使用固定的
`compatible_render` loopback 协议。详细边界见 `docs/KOUBO_RUNTIME_ENGINE.md`。

基础 rootfs、Python/CUDA 依赖和 HeyGem runtime 仍须逐项固定来源、SHA-256、许可证和
NOTICE。HeyGem Hack 中来源与再分发授权不完整的模型和 `.so` 继续 fail-closed，因此
当前不能生成或宣称可公开分发的官方 `KouboRuntime.tar`。

## 未来可切换为一体化安装的条件

只有一个具体运行包同时满足以下条件，才可考虑加入官方运行时下载或独立安装器：

1. 固定全部源代码、模型、二进制、CUDA/ONNX/Torch 组件版本。
2. 对每项资产保存来源 URL、SHA-256、许可证文本和 NOTICE。
3. 明确获得模型、`.so`、镜像层和 WSL rootfs 重新打包/分发所需授权。
4. 在 App UI、About、用户协议和分发包中落实上游要求的归属。
5. 对 Duix 当前 1,000 月活条件建立计数和商业许可决策；不能因为 App 免费而忽略。
6. 在干净 Windows 机器完成安装、重启、导入、GPU 推理、卸载和重装验收。

满足后也应把重型运行时做成独立、可校验的组件，而不是塞进主 App：用户体验仍可是一键安装，但主程序更新不必重复下载数 GB 模型。

## 发布前检查

```powershell
pnpm desktop:build
```

`desktop:build` 会先执行桌面预检。任何为演示而设置的环境变量都不能绕过运行时资产扫描。若报错 `desktop_bundle_contains_runtime_assets`，应从 `src-tauri/resources` 移除对应资产；不要通过改扩展名规避。

项目仓库自身的 LICENSE/NOTICE 仍需由发布者选择并补齐，这与第三方运行时授权是两个独立决策，不能由自动化脚本代替。
