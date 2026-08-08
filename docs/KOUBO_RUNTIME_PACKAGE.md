# KouboRuntime WSL 运行包契约 v1

`KouboRuntime` 是口播智能体管理的可替换数字人运行环境，不是 Docker 兼容层。桌面应用只接受用户主动选择的本地 WSL rootfs `.tar`，不会从未审核地址静默下载模型或二进制。

## 固定身份与路径

```text
WSL distro: KouboRuntime
WSL version: 2
Windows install root: %LOCALAPPDATA%/com.koubo.agent/runtime/KouboRuntime
manifest: /etc/koubo-runtime.json
controller: /opt/koubo/bin/koubo-runtime
API: http://127.0.0.1:8383
health: GET http://127.0.0.1:8383/health
render: POST http://127.0.0.1:8383/render
```

应用不接受 UI 传入 distro 名、安装目录、命令或启动脚本。导入由 Tauri 直接执行固定的 `System32/wsl.exe --import ... --version 2`，不经过 shell。

## 导入完整性

选择 `X.tar` 时，同一目录必须存在 `X.tar.sha256`。摘要文件只接受以下两种字节格式：

```text
<64 个小写十六进制字符>\n
<64 个小写十六进制字符>\r\n
```

不接受 BOM、大写字符、空格、文件名、缺少末尾换行或额外行。桌面端只从
`%SystemRoot%\System32\certutil.exe -hashfile <规范化 tar 路径> SHA256` 的成功输出中读取唯一 SHA-256；不搜索 `PATH`，不经过 shell，并设置 30 分钟上限。

计算摘要前，桌面端以仅共享读取的方式锁住 `.tar`，并一直持有到 WSL 导入、manifest/controller 校验完成。随后再次核对文件大小和修改时间；任一变化都会撤销本次导入。摘要文件缺失、格式错误、系统工具不可用/失败、计算超时、输出异常、摘要不匹配都会在创建安装目录之前失败。

SHA-256 只证明所选文件与旁车摘要一致，不能证明发布者身份、数字签名、模型来源或再分发授权。公开分享仍须单独完成下文的许可证和授权审查。

## 安全移除与重装恢复

设置页的“移除运行环境”只调用桌面端无参数 Tauri 命令。应用会显示 Windows 原生警告并等待用户确认，然后只对固定的 `KouboRuntime` 发行版执行 terminate/unregister；注销后必须再次确认该发行版已不存在，才会报告成功。取消不会执行任何变更。

固定安装位置为 `<appLocalData>/runtime/KouboRuntime`。普通空目录只用 `remove_dir` 移除；非空目录、文件、符号链接或 reparse point 只会在同一父目录改名为带 UUID 的隔离项，不递归删除也不跟随链接。移除不触碰 workspace、创作项目、素材或其他 WSL 发行版；完成后可以重新选择已获授权且摘要匹配的运行包导入。

## Manifest

`/etc/koubo-runtime.json` 必须是 UTF-8 JSON：

```json
{
  "schemaVersion": 1,
  "name": "KouboRuntime",
  "version": "2026.07.0",
  "apiUrl": "http://127.0.0.1:8383"
}
```

名称、schema 和 API 地址必须完全一致；版本不能为空。导入完成后应用会在 WSL 内读取并校验该文件。

## Controller

`/opt/koubo/bin/koubo-runtime` 必须可执行，并支持：

```text
koubo-runtime start   # 启动服务并在初始化提交后退出，不能永久占用调用进程
koubo-runtime stop    # 优雅停止服务；桌面端随后终止该 WSL 运行实例
```

`start` 返回成功不代表已经 ready。桌面端只有在 manifest 合法且 `/health` 返回 2xx 后才把运行环境标记为 `ready`。

## HTTP 最小协议

- `GET /health`：服务和 GPU 模型真正就绪后返回 2xx 与 JSON 身份：`{"schemaVersion":1,"name":"KouboRuntime","version":"与 manifest 相同","apiDialect":"compatible_render"}`；模型仍在加载时返回 503。应用会校验身份和版本，不能只用端口存活冒充托管环境。
- `POST /render`：实现项目现有的 `compatible_render` adapter 协议。托管模式请求携带 `pathDialect: "wsl_mount_v1"`；音频、上传形象和候选输出都使用固定 DrvFs 形式 `/mnt/<小写盘符>/...`。应用只会映射经过真实路径解析且仍位于当前 workspace 的 Windows 盘符绝对路径，拒绝相对路径、盘符相对路径、UNC、设备/扩展路径、ADS、NUL 和链接逃逸。
- 运行时可以返回 HTTP(S) `resultUrl`，由主应用按大小上限流式下载；也可以返回 `outputPath`，但它必须与本次请求中的 WSL 候选输出路径逐字完全相同。应用匹配后只使用自己保存的 Windows 候选路径，不接受其他本地或 WSL 路径，也不通过 `resultRoot` 猜测映射。
- 结果视频必须非空、可被 ffprobe 读取，并由主应用复制到当前 workspace 的 render artifact 目录。

授权的 `KouboRuntime` 包是该协议中的受信执行组件：它获得的只是当前 workspace 内本次生成所需素材路径，不代表可以扫描其他宿主目录。主应用仍负责路径门禁、结果大小限制、ffprobe、同步、原子发布和失败清理。

## 供应链与许可

计划公开发布的 App 采用“轻量 App + 外置授权运行时包”模式：技术上形成的安装包只包含桌面程序和本地 Node backend，不包含 WSL rootfs、模型权重、HeyGem/Duix/Hack 目录或其 Linux `.so`。作者公开发布前仍须为项目本体选择许可并补齐 LICENSE/NOTICE；运行包由用户主动选择并导入，且必须来自用户有权使用和重新分发的来源。免费提供软件不等于自动获得第三方代码、模型或二进制的再分发权。

公开发布前，每个包必须提供：

- 固定版本、SHA-256 和构建记录；
- 所有代码、模型、`.so`、CUDA/ONNX/Torch 组件的来源与许可证清单；
- 上游要求的 LICENSE、NOTICE、UI 归属和用户协议文本；
- 针对模型权重、二进制和重新打包为 WSL rootfs 的再分发授权。

当前仓库不附带 HeyGem/Duix/Hack 模型或镜像，也没有默认下载地址或自动下载逻辑。上游证据边界如下（不是法律结论）：

- [DUIX.COM Community License](https://raw.githubusercontent.com/duixcom/Duix-Avatar/main/LICENSE) 要求随分发材料附协议、在相关网站/UI/博客/About/文档中显著展示 `Built with DUIX.COM`、在用户协议中披露使用 DUIX.COM 技术，并保留指定 NOTICE。其当前文本还规定：相关产品或服务在版本发布日期前一自然月超过 1,000 月活，或集成产品超过 1,000 月活时，必须向 DUIX.COM 申请商业许可，获准前不能继续依赖该协议行使权利。免费分发不豁免这些条件。
- [HeyGem-Linux-Python-Hack README](https://raw.githubusercontent.com/Holasyb918/HeyGem-Linux-Python-Hack/main/README.md) 自述项目从 HeyGem.ai 提取，所有 `.so` 和模型由“硅基”提供，License 仅指向/参考 HeyGem.ai 协议；[download.sh](https://raw.githubusercontent.com/Holasyb918/HeyGem-Linux-Python-Hack/main/download.sh) 会下载 ONNX、PTH、PT 等模型。仅凭该仓库无法证明这些模型和二进制可被本项目重新打包进公开 WSL rootfs。

因此，在逐项完成许可证清单、归属展示、用户协议、月活条件处理和再分发授权前，这些资产只能作为用户自行取得的外置包来源候选，不能进入桌面安装包。若未来取得明确授权，仍须保留本节列出的版本、摘要、NOTICE 和构建记录。

## 验收

```text
导入本地 tar
→ WSL2 注册成功
→ manifest 和 controller 校验通过
→ start
→ /health 2xx
→ 主应用自动选择 managed_wsl source
→ 真实生成视频
→ ffprobe 与 workspace artifact 关联通过
→ stop 后 WSL 实例释放
```

没有通过完整验收的包只能标记为 `running` 或 `failed`，不能显示“可用”。
