# 口播智能体项目上下文

更新时间：2026-07-29

## 产品定位

口播智能体是一个 local-first 的 Windows 数字人口播制作应用：用户通过 AI 对话完成文案，用真实音色和形象生成数字人视频，在本地完成字幕与剪辑，最后由本机可见浏览器辅助发布。

唯一主流程：

```text
1. AI 对话生成文案并持续修改
2. 选择已有音色或上传 8–12 秒参考音频克隆声音
3. 选择已有形象或上传形象素材生成数字人视频
4. 本地简单剪辑，或让 AI Agent 生成精细剪辑计划
5. 打开可见浏览器辅助发布到抖音或小红书
```

产品界面只使用“文案、声音、数字人、剪辑、发布”。session、artifact、runtime、adapter 等工程概念不能成为用户的主要交互负担。

## 当前转型主线

项目已有部分真实生成链路，但混入了不属于本产品的旧外部发布系统、验收底座和展示型假素材。当前采用删除式重构：

1. 整体删除旧外部发布系统及其脚本、配置、测试、文档和 UI 残留，不保留兼容层。
2. 统一创作项目状态和 workspace，消除页面手工串联产物与浏览器存储的第二事实源。
3. 删除没有真实资源支撑的音色、形象和功能入口。
4. 做实本地字幕与简单剪辑，让手动剪辑和 Agent 精剪共用同一执行核心。
5. 优化五步 UI、错误恢复、启动性能、内存和安装包。
6. 最后建设抖音、小红书可见浏览器发布自动化。

## 技术栈与运行环境

- Next.js 16、React 19、TypeScript、Tailwind CSS v4。
- Tauri 2 Windows 桌面壳和本地 Next standalone 后端。
- 原生 OpenAI-compatible HTTP adapter 与可配置 AI Provider。
- IndexTTS2 声音 runtime。
- Duix/HeyGem 数字人 runtime。
- ffmpeg / ffprobe 本地剪辑和媒体校验。
- Node.js `>= 22.19.0`；桌面生产后端也必须满足此版本。

主 App 不强制捆绑 Docker、GPU 模型或重型 runtime。AI、声音和数字人服务可位于本机或远程机器，必须通过 adapter 隔离差异。项目、素材、中间产物和成片默认保存在本机。

## 架构 seam

```text
Tauri desktop shell
  └─ Next.js / React UI
       └─ hook / API client
            └─ API route
                 └─ module service
                      └─ adapter
                           └─ local or remote runtime
```

业务模块：

- 文案：AI 对话、文案版本和确认状态。
- 声音：音色素材、参考音频、IndexTTS2 任务和音频结果。
- 数字人：形象素材、Duix/HeyGem 任务和视频结果。
- 剪辑：受控剪辑计划、字幕、ffmpeg 执行和最终成片。
- 发布：发布文案与素材包、可见浏览器和平台 adapter。
- workspace：项目隔离、路径安全、素材、产物和恢复。

边界约束：

- 页面组件只组合和渲染，不读取文件、调用 SDK、执行命令或判断外部来源。
- API route 只校验输入并转换 HTTP 响应。
- service 维护业务状态和阶段不变量。
- adapter 处理外部协议、进程、路径映射、超时和错误归类。
- Agent 只生成结构化、可校验的剪辑计划，不能执行任意 shell 文本。
- 浏览器登录状态只存在于用户控制的浏览器配置中，不进入项目数据。

## 创作项目与 workspace

桌面生产环境默认位于 `%APPDATA%/com.koubo.agent`；开发和测试可通过 `KOUBO_APP_DATA_ROOT` 指定数据根目录：

```text
<app-data-root>/workspaces/<projectId>/
├─ project.json
├─ files/{audio,avatar,edit-media}/
├─ outputs/{script,audio,digital-human,final}/
└─ publish/
```

`project.json` 是当前项目的单一业务真相，记录五阶段状态和当前有效产物引用。每个阶段至少明确区分：

```text
idle | needs_input | queued | running | ready | failed
```

浏览器存储不能形成第二套项目状态。所有项目 id 和本地路径必须经过校验，最终解析结果不得逃逸 workspace 或用户明确选择的素材库根目录。

## 已具备的可复用能力

- Tauri Windows 壳和本地后端生命周期；正常关闭会显式停止并等待后端子进程。
- 轻量模型 adapter、结构化文案解析与可恢复 artifact。
- workspace 路径隔离和文件越界保护。
- IndexTTS2 service/adapter、参考音频校验和音频输出。
- Duix/HeyGem service/adapter、任务轮询和视频结果校验。
- ffmpeg/ffprobe 调用、媒体探测、超时和进程树清理基础能力。
- 五步创作 UI 的基本页面结构。
- 明确状态、来源和错误码的接口方向。

这些只表示代码基础可复用，不代表所有入口、真实 runtime 和 UI 已完成最终验收。

## 待实现和待收敛

- 在抖音、小红书真实页面由用户监督完成登录和选择器验收；平台变化只能修改 adapter。

## OpenChatCut 真实分阶段 smoke

OpenChatCut 的真实验收使用显式门控测试
`lib/openchatcut/openchatcut-real-smoke.integration.test.ts`。它不会在普通
`pnpm test` 中加载 OpenChatCut 生产集成，也不会启动、关闭或修改用户现有的
OpenChatCut 实例。测试只在仓库的
`artifacts/verification/openchatcut-real-smoke/<runId>` 下创建独立 workspace，
不会读取、覆盖或删除 AppData 中的创作项目；AI Provider 仍读取应用当前真实配置，
不会复制或输出密钥。

第一阶段构造合法的文案 → 声音 → 真实 HeyGem 视频 lineage，自动创建和导入
OpenChatCut 项目，并生成 manual approval 草案。PowerShell 中执行：

```powershell
$runId = "20260728-openchatcut-01"
$env:RUN_OPENCHATCUT_REAL_SMOKE = "1"
$env:OPENCHATCUT_REAL_SMOKE_PHASE = "create"
$env:OPENCHATCUT_REAL_SMOKE_RUN_ID = $runId
$env:KOUBO_APP_DATA_ROOT = Join-Path $env:APPDATA "com.koubo.agent"
$env:KOUBO_WORKSPACES_ROOT = Join-Path $PWD "artifacts\verification\openchatcut-real-smoke\$runId\workspaces"
pnpm exec vitest run lib/openchatcut/openchatcut-real-smoke.integration.test.ts
```

`KOUBO_APP_DATA_ROOT` 必须显式指向应用真实数据根；smoke 从其中读取 AI
Provider 配置，并读取或更新受管 OpenChatCut 会话设置，但不访问
AppData 下的 `workspaces`。全部测试项目仍由单独的
`KOUBO_WORKSPACES_ROOT` 隔离。

`create` 成功后必须在可见 OpenChatCut 中预览并批准草案。公开的 `review`
调用只把草案送入审核，不代表用户批准。批准后保留同一个 PowerShell 会话和
`runId`，执行第二阶段：

```powershell
$env:OPENCHATCUT_REAL_SMOKE_PHASE = "export"
pnpm exec vitest run lib/openchatcut/openchatcut-real-smoke.integration.test.ts
```

第二阶段读取同一 bridge、核对远端会话已经 `applied`，然后导出到该隔离
workspace，并验证 MP4 非空、ffprobe 可读、包含 H.264 视频流，且项目
`edit` 阶段为 `ready/openchatcut`。如果仍未批准，会明确返回
`openchatcut_smoke_waiting_for_manual_review`；外部实例冲突、Provider 未配置和
导出失败分别使用 `openchatcut_smoke_external_instance`、
`openchatcut_smoke_provider_not_configured` 和
`openchatcut_smoke_export_failed/*`。`create` 永不覆盖已有 `runId`，需要重试时
请换新 id；证据目录由用户确认后自行归档或删除。

## 当前已验证切片（2026-08-08）

- OpenChatCut 自动导入顺序已修正：service 读取受管随机 loopback CDP 端口后，先由唯一 Electron CDP adapter 从精确同源根页安全打开 bridge 记录的精确项目 editor hash；随后在 30 秒单调 deadline 内轮询结构化 `openchatcut_status.connectedProjectIds`，确认目标项目已连接后才允许首次 `read_project`。状态格式错误、永久 pending、连接超时和非空时间线都在上传前稳定失败；上传后必须用 fresh MCP 连接重新 `target_project`，精确核对返回项目 ID，再读取并验证唯一落库视频，任何错配或失败都不会进入 `ready_to_draft`。该切片已通过 adapter/service/门控关闭 smoke 的自动测试，尚未执行新的真实 OpenChatCut 冷启动导入复验。
- OpenChatCut 受管启动已加入安装完成门禁和实例身份校验：即使安装目录先出现 `OpenChatCut.exe`，只有 package、桌面主进程、MCP zod-compat 以及 zod v3/v4-mini 关键入口都成为非空常规文件后才允许启动；只有当前后端确实持有的可见安装器进程未退出时才报告“安装中”，安装器已结束但 payload 残缺会稳定返回 `install_incomplete`，并优先使用已校验缓存包执行“修复安装”。MCP 与持久随机 CDP 端口会独立探测：受管 OpenChatCut page 已存在而 MCP 尚未就绪时保持 `launching` 并只等待原实例，绝不重复启动；只有 MCP 而没有受管 CDP 证明时稳定报告外部实例冲突。DevTools browser 和 page WebSocket 都必须是同一持久 loopback CDP 端口。并发启动请求由 service single-flight 合并，设置页使用无重叠递归轮询和请求 epoch，旧 GET 不能覆盖安装或启动 mutation。
- OpenChatCut 官方安装包摘要检查已按规范化路径、size、mtime、ctime 和 inode 缓存，设置页高频检查不会反复读取约 538 MiB 文件；文件身份变化、下载失败或删除会使缓存失效，真正执行安装器前仍始终重新计算 SHA-256。安装器启动会等待子进程 `spawn` 或异步 `error`，不会把启动失败误报成功。
- OpenChatCut 专业剪辑已升级为可恢复 v3：固定 v0.1.6 Windows x64 官方安装包与内置 SHA-256，下载在后台执行并暴露 received/total/percent/stalled；下载任务和失败状态按 AppData runtime root 隔离，检查入口会同步捕获当轮下载，真实下载错误优先于下载中和残缺安装状态，成功后下一轮稳定回到可修复安装状态。本版本残留临时文件会清理，启动 installer 前再次计算摘要。生产环境只从用户目录和固定 Program Files 候选查找并做 realpath 约束，不接受环境覆盖。
- 受管 OpenChatCut 进程使用每次启动随机的 loopback CDP 端口；启动环境会清除外来 editor URL/token，只注入应用已配置 token。App 进程必须收到异步 `spawn` 确认后才报告成功，并在 `close` 前持有晚到 `error` guard，避免启动误报和未处理进程错误。首次状态检查、必要的 App 启动和后续 MCP 轮询现在共同消费一个基于 `performance.now()` 的 45 秒单调 deadline，不再按轮询次数估算：状态检查或间隔永久 pending 也会按时退出，迟于 deadline 完成的结果不会被接受，晚到 rejection 已被观察且不会形成未处理异常；有副作用的 App 启动本身不被竞态中断，但返回后若预算耗尽会立即超时。MCP 探测与有界等待使用同一 token，401 与会话 404 有稳定错误，工具调用只对过期会话重握手一次；启动前发现无法验证的外部实例会立即拒绝且绝不 spawn。只有 App 已确认 `spawn` 成功或此前已经观察到受管 `launching` 时，`MCP ready + CDP page 尚在出现` 的短暂 `external_instance` 才会在同一 deadline 内继续等待；若身份不匹配持续到 deadline，则返回稳定的专用外部实例错误。认证失败、安装状态变化和受管窗口关闭仍是立即终态；冷启动最初的 `installed` 不会误判退出，只有已经见到 `launching` 后回落到 `installed` 才归类为受管窗口关闭；工具白名单没有扩大，仍不把上传或导出描述为 MCP 能力。
- 自动导入与导出只经过唯一 Electron CDP adapter：自动导入仅在 MCP 证明空时间线后，对官方空画布文件框选择当前 workspace 视频，等待 `/api/normalize-media` 成功，再用新 MCP 会话确认唯一视频已落为 `/media/uploads/...` 且时长匹配；失败保留真实的手动接管状态。
- AI 草案仍使用 manual 隔离会话并由用户在可见 OpenChatCut 中批准。批准后可自动打开导出面板、开启导出后质量检查并下载 MP4 到 workspace 临时 part；文件经 fsync、非空以及一次有界 ffprobe 同时验证时长和 H.264 视频流后，才原子提交为后期产物。探测默认 30 秒超时，Windows 会终止 ffprobe 进程树并在 `taskkill` 失败时回退终止直接子进程。
- OpenChatCut AI 草案已将受控 `EditPlan` 映射到真实内置能力：整批 `edit_item` 增加项先 `validateOnly` 后实调，镜头运动固定使用 `builtin:zoom`，鲜艳/暖色调固定使用低强度内置 look，高能/电影预设固定使用内置清晰度或暗角与胶片颗粒；字幕只通过白名单 `edit_captions` 启用固定模板或关闭。模型不能提供 MCP 工具名和 OpenChatCut `assetId`。草案使用一次性 manual session 读取和持续锁定唯一视频的 timeline、item、src 与精确时长；每个 session 必须确认 discard，任何未确认、超时、迟到结果或身份变化都会失败封闭。草案仍必须由用户在可见编辑器中审核。
- OpenChatCut 转写就绪门禁进一步按安装能力做结构化探测：只有 `tools/list` 明确暴露目标枚举含 `transcription` 且参数含 `assetIds` 的 `track_progress` 才会调用；当前实测 v0.1.6 的 40 个外部 MCP 工具不满足该条件，因此使用只读 CDP/IndexedDB 兜底。兜底必须锁定唯一 loopback 编辑页、精确项目 hash、`openchatcut` v1/`kv` 的精确项目键和唯一匹配源素材，只返回清洗后的 `running|succeeded|failed|not_found` 以及 `auth|network|unknown` 错误码。只有可证明的 `auth` 失败允许生成一次无自动字幕草案：Provider 仍只调用一次，生成结果会被强制关闭字幕并移除动态字幕效果，首条审核说明明确提示转写凭据失效；其他错误继续失败封闭。每次 readiness/stability 读取使用一次性 manual session，只有 discard 成功或同一 session 的结构化状态确认 `discarded` 才可清除身份并继续；discard pending、未确认或耗尽同一单调 deadline 都会分别收敛为 `captions_not_ready` / `project_not_stable`，不会进入 Provider 后续修改、审核或返回就绪。真实 MCP 客户端归一化后的 `OpenChatCutMcpError(code=mcp_timeout)` 属于可恢复的精确超时，其他 MCP 错误不会被吞掉。
- OpenAI-compatible 剪辑计划对精确规范化模型 `deepseek-v4-flash` 显式发送 `thinking.type=disabled` 并保留 1,400 token 最终输出上限；其他模型仍沿用原有 700 token 配置。官方当前兼容契约说明 thinking 默认开启、`low/medium` 会映射为 `high`，且 `max_tokens` 同时覆盖 CoT 与最终答案；真实 v37 已证明 `low+1400` 仍可能只返回 `reasoning_content` 而没有最终 `content`。adapter 只接受最终 `message.content`，绝不把 `reasoning_content` 当作计划或暴露其内容，后续 JSON 与 `EditPlan` schema 校验保持不变；运行时 usage 记录实际下发的 1,400/700 上限。
- 真实 v38 已证明草案 client 的 95 秒受管等待 transport 不能复用于普通 MCP 变更：AI 计划缓存写入与失败 bridge 更新相差 199.131 秒，其中稳定会话 3 次静默确认约 9 秒，随后首个 `manage_timelines` 和 catch cleanup 的 `discard_edit_session` 各耗尽 95 秒。根因是 draft client 的单一默认 timeout 放大了所有调用；catch 还吞掉 cleanup timeout 并无条件写 `discarded`，导致无法证明的远端状态被误报。现在 MCP client 支持逐调用 timeout：同一次 `callTool` 只创建一个 AbortSignal，并让初次请求、一次过期会话重握手/通知与重试共同消费该预算。readiness/stability 仍共享 90 秒业务 deadline 和最多 95 秒 transport；`target_project`、草案变更、manual review、editor URL 刷新及失败 cleanup 的整个调用固定为 8 秒。普通变更失败只返回白名单分类 code 与固定本地 `message/stage/toolCode`，MCP 文本、RPC message、structured error 和调用参数都不会进入 API、bridge 或日志。cleanup 未确认时 bridge 保留 `drafting + editSessionId` 和人工检查指引，只有成功响应才写 `discarded`；若该恢复状态本身无法原子保存，则不再吞掉写失败或回落到原 apply error，而是返回固定 `bridge_persist_failed`，并只附带安全的 `inspect_and_discard/editSessionId` recovery reference，要求用户在可见编辑器中检查。该修复已通过本地 TDD，尚未用新的真实 runId 复验。
- v38 后续已在固定 0.1.6 bundle、唯一受管页面和用户明确接受覆盖旧 proposal 历史的门禁下完成两次稳定只读 IDB 快照、同 URL reload、新 editor 身份校验及一次专用 manual `begin → discard → get` 双确认；证据只说明 v38 被明确放弃、reload 清除了内存 drafting、全新 probe 已清理，不把旧 session 谎报为 discarded。随后唯一 v39 create 在生成 AI plan 后未进入 `needs_review`：plan cache 写入与失败 bridge 写入相差 25.103 秒，bridge 保留 `drafting + editSessionId`。该时长只能精确证明 cache 后约 9 秒稳定门禁、一个 `draft_apply` 工具耗尽 8 秒以及 cleanup `discard_edit_session` 再耗尽 8 秒；旧 real-smoke assertion 丢弃了 service 已返回的安全 `stage/toolCode`，因此仅凭文件时间戳不能在 `manage_timelines/edit_item_validate/edit_item_apply/edit_captions/review_edit_session/get_editor_url` 中唯一归因，禁止事后猜测。现在 cleanup 未确认时会在保留原安全错误上下文的同时附带 `inspect_and_discard/editSessionId` recovery，real smoke 也只显示白名单 `stage/toolCode` 和格式受限的 recovery identity，任意恶意字段不会进入输出。0.1.6 的 `manage_timelines(update)` 本身是同步内存命令，其他草案工具也没有当前证据证明合法执行必然超过 8 秒，故暂不扩大任何特定工具或全局 timeout；应由下一次新 run 的安全 stage/toolCode 证据决定是否只调整一个工具的有界预算。
- 已安装 OpenChatCut 0.1.6 的真实 bundle 证明 v38 遗留 drafting session 当前无法通过只读调用安全判定为 terminal absent：编辑器把 drafting session 只保存在进程内 `Map`，仅在 review/discard/apply/reject 时将 `external-proposal:<projectId>` 写入持久存储并在重载时 hydrate；`get_edit_session` 与 `discard_edit_session` 都先执行同一个内存 `requireSession`。未知 session 由编辑器抛普通 Error，经 external-agent bridge 仅以 `ok=false + string value` 回传，桌面 MCP 再包装为 `isError=true + text content`，没有稳定的 `code/data/structuredContent`。`openchatcut_status` 只返回 connected project/editor/tool count，`list_projects` 只返回项目 metadata，均不是 session 权威状态。我们的 MCP client 没有丢失该版本可用于判定的结构化错误；即使不可信服务声称 `structuredContent.code=session_not_found`，也继续归类为普通 `tool_error`，禁止按英文 message 猜测 session 缺失。一个需要独立权限和明确数据代价的恢复例外，是用户明确接受覆盖该失败 OpenChatCut project 的既有 proposal 历史后使用专用 `begin → discard → get` 双确认探针：先精确 target/read 锁定项目身份，再创建全新的 manual session 并核对返回的新 session 身份，随后只放弃该新 session，最后用 `get_edit_session` 精确确认同一新 session 为 `discarded`；`begin` 成功证明当前 editor session manager 没有活动中的 drafting/awaiting session，而 `discard` 会把 `external-proposal:<projectId>` 改写成新终态记录，永久覆盖该项目先前保存的 proposal 历史。任一步身份、状态或调用失败都必须关闭失败。该专用探针不是通用 `discard`：对旧 session 的普通 `discard_edit_session` 错误仍无结构化含义，绝不能借此宣称旧 session 已不存在。若不接受历史覆盖，只能等待 OpenChatCut 提供固定结构化错误码或只读 session 状态接口。
- 用户触发的通用 `runOpenChatCutSession(action='discard')` 现在只在远端回执的原始字段同时严格满足 `typeof editSessionId === string && editSessionId === 请求值` 与 `typeof status === string && status === 'discarded'` 时才保存本地 `discarded`，比较前绝不 trim 或规范化；`applied`、`rejected`、其他状态、空白包裹字段、缺失或错配身份、畸形结果及工具失败全部返回固定本地 `session_discard_unconfirmed/session_discard/discard_edit_session`，并保持原 bridge 文件字节与 session 身份不变，要求在可见编辑器中检查，不透传远端正文。远端已经精确确认后不再调用可失败的 `get_editor_url`，而是重新校验并复用当前 bridge 中既有的 loopback 精确项目 URL；从本地 bridge 构造、URL 复核到原子保存的任一失败都统一返回固定 `bridge_persist_failed/session_discard/bridge_persist`，不会分叉成普通 MCP/URL 错误，也不会把未落盘的本地状态谎报为成功。
- AI 草案失败后的 catch cleanup 与用户触发的通用 discard 现已共用同一个纯严格确认谓词：只接受原始 `editSessionId` 与请求值逐字相等且原始 `status` 逐字等于 `discarded`。cleanup 返回 `applied`、`rejected`、`awaiting_review`、错配/缺失身份、缺失状态、任一字段带空白、畸形工具错误或抛错时，bridge 一律保持 `drafting + editSessionId`，原始安全草案错误仍保留并附带 `inspect_and_discard`；只有精确确认才写 `discarded`。精确确认后的 bridge 原子保存失败仍固定收敛为 `bridge_persist_failed/draft_cleanup/bridge_persist`，不会附加误导性的未确认 recovery；TDD 同时断言原始 bridge 文件字节在保存失败时不变。
- 本地 bridge 因调用进程中断而停在 `drafting` 时，通用 `status` 现在使用独立的只读对账分支：精确核对 bridge、请求中的 project/session 身份后，在共享 10 秒单调业务 deadline 内只调用 `target_project → get_edit_session`，并要求两个响应的原始 project/session ID 逐字一致且原始状态严格等于 `discarded`。该分支绝不调用 `discard_edit_session` 或 `get_editor_url`；成功前重新校验 bridge 已保存的精确 loopback editor URL，然后原子写入 `discarded`。身份缺失/错配/空白、任意其他状态、transport 错误、业务 deadline、迟到完成及畸形响应都固定返回 `session_reconcile_unconfirmed/session_reconcile/get_edit_session`，不透传外部正文且保持原 bridge 文件字节不变；原子保存失败固定返回 `bridge_persist_failed/session_reconcile/bridge_persist`。真实 smoke 显式使用 10 秒对账预算，测试壳固定为 300 秒，避免默认 5 秒测试超时在 service 完成安全落盘前截断，同时仍保持业务调用有界。
- OpenChatCut bridge v4 只保存项目、阶段、loopback 编辑地址、产物 lineage 和导出 operation/session 身份，不保存外部文件路径，也不写 OpenChatCut project-store。`exporting` 必须持有 operation/session，`exported` 的 artifact 必须等于 operation；同项目同 operation 的进程内 registry 阻止重复 CDP 导出。GET 会对账当前 edit stage：精确匹配的 ready 产物可补写 bridge，运行中遗留的完整 H.264 MP4 可重建 artifact 并完成项目事务，无有效产物会只失败原 operation 后回到 applied；不同 operation、session 或上游绝不覆盖。恢复时源视频时长只用于源身份，不限制用户剪短或延长后的成片；已有 artifact 只将实际探测时长与自身记录做小容差核对，缺失 artifact 时则以裸 MP4 的实际正时长重建记录，存在但无效的 artifact 不会降级重建。v3 exporting 只有在当前 edit operation/source/session/upstream 精确可证明时迁移，否则安全回到 applied。
- OpenChatCut 0.1.6 的 manual review 调用可能已把 proposal 持久化为 `awaiting_review`，但 MCP 响应仍耗尽 8 秒。MCP adapter 现提供只返回清洗后 `editSessionId/status` 的精确持久状态读取；`review_edit_session` 超时后，只有同一 project key、同一 session 且状态映射为 `needs_review` 才恢复成功，proposal 正文不会进入 service。普通 `status` 的 MCP 调用失败时也使用同一只读回退，只接受逐字匹配 session 和 `applied|rejected|discarded|awaiting_review|pending_review|review`，身份或状态不明继续返回原错误。Provider 偶发返回文案中不存在的非关键 `creative.emphasis` 时会删除这些词并保留其余合法计划，类型/长度、未知字段、asset 和受控 `EditPlan` 校验不放宽。
- 真实分阶段 smoke `20260729-openchatcut-v42-a1` 已完成同一 runId 的 create → 用户可见审核 → export：OpenChatCut project `740d2bce-48e5-498a-986e-eddd255e277f`、manual session `b770f346-348f-4685-a87a-51997e3bc62b`；最终 bridge 为 `exported`，`project.json` 的 edit 为 `ready/openchatcut`，artifact `openchatcut-5244a50e-a962-4d8a-8b8c-95ee0b00b14b` 保持 `render-real-smoke/script-real-smoke` lineage。成片为 3,993,604 bytes、SHA-256 `8014B40BE4BEB7D375AE880A04C8852A01425EC60493D5731D227D1E3DC28541`，ffprobe 为 H.264、1080×1920、5.717333 秒。2026-08-08 使用 bundled Node 24.14.0 验证全量 145 files passed/7 skipped、1005 tests passed/8 skipped，typecheck、production build、desktop build 均通过；最终 NSIS 为 35,258,735 bytes、SHA-256 `7A1FCDE35C651B21E8C4C097FAC79A3B49F4DCDD7BC7481BE9E730F91C7AFED0`。
- 专业精剪 UI 在 `exporting` 时只通过 GET 自动轮询和手动刷新对账，不会再次发送 export；project/request epoch 会丢弃旧项目或旧请求的迟到响应。
- 默认 workspace 下的参考录音 → IndexTTS2 音频 → 上传形象 → Duix/HeyGem 视频完整真实链路已通过。
- 剪辑已迁移为受控 `EditPlan v1`，客户端不能提交 skill 或脚本路径。
- AI 精剪已收敛为低 Token 决策链路：本地先提取时长、文案长度、可用素材和当前计划，发送给模型的文案最多 1,800 字、指令最多 400 字，模型只返回短字段白名单决策；普通模型输出预算为 700 tokens，精确规范化模型 `deepseek-v4-flash` 关闭 thinking 并保留 1,400 tokens 最终输出上限，运行时 usage 记录实际下发预算。相同输入由 workspace 内 SHA-256 持久缓存复用，缓存命中不再调用云端模型。
- `EditPlan v1` 已真实支持 `cover/contain` 画幅策略和静音压缩参数；本地 ffmpeg 执行静音检测、带边界留白的多段裁切、音频切点淡化、字幕时间重映射、画幅裁切/补边和最终编码，模型不能返回路径、滤镜或任意命令。
- 真实 HeyGem 口播样片的 AI 精剪 smoke 已通过：Gemini 3.1 Pro 在低推理强度下由 1,024 tokens 降至 673 tokens，重复运行命中缓存时云端消耗为 0；成片已由 ffprobe 验证为 720×1280、H.264/AAC、1:1 SAR 的有效 MP4。
- 本地剪辑由 TypeScript adapter 直接调用 ffmpeg/ffprobe，已真实支持画幅、完整多段 SRT、字幕烧录、原声音量、封面时间点和 H.264 MP4。
- 成片页面播放真实 artifact，并支持 HTTP Range；不再展示静态假成片。
- 项目列表、五阶段状态和当前有效产物已迁移到 workspace `project.json`；localStorage 只用于一次性导入旧项目，不再是第二事实源。
- 声音与形象素材 API 已支持真实列表、导入、媒体读取、预览、复用和删除；硬编码假音色、假形象已从主 UI 清除。
- BGM、片头和片尾已有 workspace 素材库、导入/预览/选择/删除 UI，并通过相同 `EditPlan` 由 ffmpeg 真实混音与拼接。
- BGM + 片头 + 主体字幕/音量 + 片尾的真实媒体 smoke 已通过，导出结果包含有效视频和音频流。
- 首页已收敛为单一“新建口播”入口，五个重页面按需加载；视频号假入口和生产环境 Vercel Analytics 已移除。
- 桌面 backend 已排除 workspace、Provider 配置、会话、文档、环境文件和浏览器二进制；移除 Pi 后资源为 6,415 个文件、约 202.5 MiB，NSIS 安装包为 33.40 MiB。
- 桌面实机验证通过：启动后首页 200，正常关闭后壳、Node 子进程和 3100 端口全部释放；运行数据写入 AppData，不写安装资源目录。
- 音频、形象、剪辑素材上传已改为限额流式落盘和原子完成；六类媒体读取已统一为流式响应，最终成片保留 HTTP Range。
- 三个大素材上传入口已绕过 Next Proxy 的 10 MiB 请求克隆上限并在 route 内保留同等来源校验；64 MiB chunked 和 300 MiB Content-Length 均精确保存且 SHA-256 一致，300 MiB Node 工作集峰值约 101.20 MiB。
- production standalone 已有 12 MiB 自动回归，固定长度和 chunked 都校验 API size、磁盘 size 与 SHA-256。
- 抖音、小红书可见浏览器发布已接入：使用 AppData 独立 profile 和系统 Chrome/Edge，自动上传并填写后停在最终提交前；代码不存在最终发布动作。
- 发布 adapter 已通过真实系统 Edge 本地 fixture：延迟登录、隐藏 uploader、上传后异步编辑器、原生输入框和 contenteditable 回读校验均覆盖；待人工提交时禁止静默切换平台。
- 浏览器填写只允许停留在各 adapter 固定官方 origin 与发布 pathname（query/hash 可变）：上传前和全部填写后双重校验；文件选择后会从上传框回读并精确核对目标文件名。登录检查仍允许平台重定向，真实 Playwright fixture 通过拦截官方 URL 本地响应，测试不会访问平台公网。
- 已选择的发布包和仍在运行的浏览器 snapshot 会在返回发布页时恢复，不再把组件重新挂载误显示为空。
- 单个损坏 `project.json` 会被隔离为 degraded 状态，有效项目继续显示并允许重新读取；不会自动删除用户损坏数据。
- 空 AppData 的默认本地 Provider 显示“待测试”，只评估默认 Provider，短探测成功后才报告 ready。
- 文案 Agent 使用原生非流式 OpenAI-compatible 请求，不依赖外部 Agent SDK 或持久会话；保留结构化解析、一次修复与 artifact 状态。
- AI Provider 环境检查已使用 `model_provider` 真实状态并直接读取设置存储/连接探测，不再通过旧 smoke 环境变量合成状态；设置页删除 runtime profile、“完整验收”、P 优先级、证据和命令/env 复制等治理 UI，只展示真实状态、用户可理解的下一步和本地运行时配置。
- 无生产调用者的 Skill Registry API、hook、斜杠菜单和 `selectedSkill` 请求分支已删除；文案聊天保持普通自然语言交互，Agent 精剪继续使用受控 `EditPlan`，不依赖 Registry 假功能。
- acceptance/doctor/real-runtime-evidence 包装层与历史 Pi smoke 已删除，只保留一条 `smoke:model-provider` 真实 Provider→文案 artifact 链路，环境变量统一为 `MODEL_PROVIDER_SMOKE_*`。
- production standalone 已真实验证 `/v1/models` → `/v1/chat/completions` → 文案 artifact 完整链路，HTTP 200。
- 设置页默认只显示当前 AI 服务；其他 Provider、生成服务和高级项折叠，真实 Edge 首屏验证无控制台错误。
- 高级设置提供用户显式触发的旧 workspace 导入：只复制有效项目的 `project.json/files/context/outputs/artifacts`，不覆盖现有项目、不复制 sessions、不修改源目录，损坏项目逐项隔离。
- 最新验证为 126 个测试文件、543 项测试通过，5 个环境型测试跳过；桌面 release smoke 为 `local_backend_ready`，Node 24.14.0。
- 浏览器控制命令受同源校验和每次启动随机 token 保护；桌面退出会先关闭浏览器 context，再终止本地后端。
- 设置页已加入 Windows 数字人环境检查：真实检测 Windows build、WSL 2、虚拟化、NVIDIA GPU/显存/驱动、内存、运行盘空间和专用 `KouboRuntime`；硬件等级与可安装的 WSL 前置条件分开表达。
- WSL 未安装时仅允许桌面 UI 调用固定 Tauri 命令 `wsl.exe --install --no-distribution`，由 Windows UAC 明示提权；Web/API 不能传入命令或参数，也不会静默安装 Ubuntu、Docker 或数字人模型。
- 当前开发机实测为“流畅运行”：WSL 2、虚拟化、RTX 4090 Laptop 16 GB、63.6 GB 内存和磁盘空间均通过；`KouboRuntime` 尚未安装，因此完整数字人免 Docker 运行包仍是下一切片。
- `KouboRuntime` 已有独立 `managed-runtime` 状态边界和 v1 包契约：桌面端原生选择本地 `.tar`，固定导入到 LocalAppData 的 WSL2 发行版，校验 manifest/controller，并提供固定启停命令；未取得授权前不内置或镜像 HeyGem/Duix/Hack 资产。
- `KouboRuntime` 导入强制要求同目录 `X.tar.sha256`（严格小写 64hex + LF/CRLF）；Tauri 从固定 `System32/certutil.exe` 直接计算摘要，在创建安装目录前拒绝缺失、格式异常、工具失败/超时、输出异常和不匹配。Windows 源 tar 以仅共享读取方式锁定到导入与 manifest/controller 验证结束，随后复核 size/mtime；成功结果携带已验证的小写 SHA-256。摘要只表示完整性，不代表签名或授权。
- `KouboRuntime` 已支持设置页安全移除和重装恢复：无参数 Tauri 命令持有与导入/启停相同的 single-flight 锁，在后台线程显示原生确认，只注销固定发行版并在注销后重新探测。固定安装路径的空目录单层删除，非空/文件/reparse 项只在同父目录 UUID 隔离，绝不递归删除或跟随链接；创作项目、素材和其他 WSL 不受影响。
- 数字人生成入口已接入按需 runtime 门禁：页面加载只并行检查真实 HeyGem readiness 与 `KouboRuntime` 状态，绝不静默启动 WSL；用户点击生成后才重新检查，已配置的本机/远程 HeyGem 可直接使用，托管 runtime 停止时只启动一次，运行中只做有界轮询。缺包、检查失败、启动失败和超时都会阻止生成并给出“打开设置”恢复入口；等待期间上传、删除、切换和重复生成全部锁定。
- HeyGem/Duix 结果接入已加固：本机结果必须位于显式配置且通过真实路径校验的 `resultRoot`，远程 runtime 只能返回 HTTP(S) 结果；远程视频按 2 GiB 上限流式落盘，本机结果也先复制到同目录随机候选文件，脚本模式同样写入候选路径；候选视频通过非空与 ffprobe 校验、同步后才原子替换最终成片，超限、断流、复制失败、无效视频和符号链接越界均不会覆盖旧成片或留下半成品。
- HeyGem 恢复客户端已使用 project/session epoch、AbortSignal 和 single-flight 隔离旧请求；瞬时 GET 错误按 1/2/4/8 秒有界退避继续对账，确定性损坏停止重试，POST 结果不确定时回到 GET 核验。只有 task、ffprobe 已验证 artifact、当前项目 digitalHuman stage、operation/session 和文案/声音 lineage 全部一致时才返回并展示成片。
- 数字人页面不再从 task id 或 POST 返回值自行推断完成；已验证视频还需在本地预览成功加载 metadata 才开放下一步。恢复/生成/上传/删除期间形象库交互双层锁定，视频读取失败会撤销完成资格；全局左右方向键跳页已移除，不能绕过阶段按钮门禁或劫持视频控件。
- 数字人成片文件接口只授权 `project.json` 当前 `digitalHuman.ready` 产物，并核对 operation、session、声音和文案 lineage；render artifact store 会拒绝 artifactId/projectId/featureType 身份篡改。媒体读取限制在 render 根目录，拒绝最终符号链接和父目录真实路径逃逸，并从同一个已打开文件句柄读取状态与流，避免旧的 stat/open 替换窗口。
- 数字人生成公共输入已收敛为 `avatarAssetId + mode`；UI 和 API 客户端不能提交文案、声音 artifact id 或本地文件路径。service 只从当前 `project.json` 的已确认文案、就绪声音和当前 workspace 形象索引解析内部 adapter 输入，并拒绝跨项目身份、索引路径不一致、真实路径逃逸、缺失或无法探测的形象视频。
- 本地剪辑已接入 `edit queued → running → ready/failed` 项目事务和 operation CAS；任务状态按 session 原子持久化并记录运行实例，GET 会在断线或重启后用成片文件、ffprobe 与当前数字人/文案 lineage 对账。剪辑页面只展示该恢复接口验证的 artifact，视频 metadata 实际加载成功后才开放下一步，不再以 POST 返回值或传入 artifact id 推断完成。
- ffmpeg 成片、SRT 和封面先写入同目录唯一候选文件；全部通过非空与 ffprobe 校验并 fsync 后，按字幕/封面/主 MP4 顺序原子 rename 提交，主成片最后可见。失败会清理候选和临时文件，不留下可被恢复链路误认的半成品。
- HeyGem 任务状态改为同目录随机临时文件原子写入并记录运行实例归属；读取到属于上一次应用实例且超过 15 分钟的 `queued/running` 才会恢复为明确的 `failed/task_interrupted`，当前实例的长渲染不会被误判，损坏状态返回稳定 `task_state_corrupt` 且不覆盖原始数据。
- IndexTTS2 任务日志已对齐相同的原子写入、运行实例归属和损坏分类，并增加进程内 active registry：只有当前仍在执行的长任务免恢复，请求已经退出但终态写入失败的任务不会永久停在 running；queued/running、adapter、artifact、session metadata 和 ready 六个持久化故障窗口均返回稳定错误。
- `project.json` 已加入项目级串行写、随机临时文件原子替换、阶段 operationId CAS、来源/会话/上游 lineage 校验和步骤前置门禁；文案确认与声音生成已在 service 内真实推进 `script ready` 及 `voice queued → running → ready/failed`，成功响应不再依赖页面事后选择产物才能形成业务状态。
- 发布包已迁移为 service 内的 `publish queued → running → ready/failed` 事务：公共请求不再提交成片 ID，只读取当前 `project.json` 的 `edit.ready` 与文案 lineage；发布包 JSON 原子写入并校验项目身份，读取、打开浏览器和实际填写前都会重新确认它仍是当前 `publish.ready` 产物。页面不再在 POST 成功后补写 `select_artifact`，最终发布仍只能由用户在可见浏览器中手动确认。
- 文案、音频 artifact 与 artifact index 已改为同目录随机临时文件、同步和原子替换；同一 index 的完整读改写由进程内串行锁保护，并发写入不会静默丢记录，失败不会覆盖已有产物。
- IndexTTS2 的 GET 恢复对账不再只信 JSON：ready 音频必须仍位于 workspace 音频根目录，真实路径不可经符号链接逃逸，文件必须存在、非空且通过 ffprobe；无效产物不会返回播放，项目同一 operation 以稳定错误码幂等进入 failed。
- Windows 环境体检固定从 SystemRoot 调用 PowerShell、WSL 和 NVIDIA 工具；WSL 功能探测未知时不会伪装成“未安装”或开放安装按钮，低版本 Windows 使用正确的 Build 文案。硬件等级与软件可用性分开展示，缺少 WSL 时明确显示“需要安装 WSL”，缺少 KouboRuntime 时只显示“硬件已通过”，不再宣称数字人已可流畅运行。
- 桌面一键安装 WSL 已迁移为异步 Tauri 命令，固定执行系统 `wsl.exe --install --no-distribution` 并通过 UAC 明示提权；不会阻塞桌面事件线程，并稳定区分取消授权、需重启、启动失败和异常退出。
- Windows 体检会在详情中展示实际 WSL 组件版本、GPU 型号/显存/驱动、内存和磁盘余量，并单列 KouboRuntime；无法读取发行版列表时返回 unknown，不再伪装成“未安装”。系统默认发行版版本不再被误当成 WSL 2 能力门禁，因为 KouboRuntime 导入会固定指定 `--version 2`。
- WSL 安装在 Tauri 原生边界增加了 single-flight 互斥；重复调用不会并发弹出多个 UAC。安装结果要求重启时，UI 会覆盖旧体检快照并禁止再次安装。
- 桌面 backend bundle 已改为根级运行文件白名单，只允许 standalone、依赖、静态资源、Agent prompt 和 Node runtime；生产配置不再扫描项目根开发环境文件，复制后会递归删除 source map，并在安装前拒绝任意 `.env*`、源码/测试/docs、工作区或根级用户媒体。standalone 中 pnpm 生成的 Windows Junction 不再交给 Node `cpSync(..., dereference)` 递归处理：资源准备器会逐节点解析真实路径，只允许 standalone 与 workspace `node_modules`、各自的 static/public 根，沿当前祖先链检测循环，把允许的链接物化为普通文件或目录，并以 `desktop_bundle_source_escape`、`desktop_bundle_source_cycle`、`desktop_bundle_source_unsupported` 稳定拒绝越界、循环和不支持节点；pnpm package 补平也复用同一复制边界。
- 2026-07-29 使用 Codex bundled Node v24.14.0 完成真实 `desktop:build`：资源树为 6,267 个文件、191.99 MiB，源资源与 release 资源均为 0 个 reparse point、0 个 `.pnpm`、0 个禁止内容；主程序 `src-tauri/.target/release/koubo-agent.exe` 为 9,490,944 bytes，SHA-256 `BAF401CEB40C76A15A9359634F073DD0582BC1F9CA1259311464FFFFDCA4BBF6`；NSIS `src-tauri/.target/release/bundle/nsis/口播智能体_0.1.0_x64-setup.exe` 为 35,253,810 bytes，SHA-256 `10BC72D474433F4342B419D447AD035D08D934302C745234A8A4E9B035F13078`。
- 运行时分发已固定为“轻量 App + 外置授权 KouboRuntime”技术模式；这表示可构建不含第三方 runtime 的轻量包，不表示项目已取得公开分发资格。作者发布前仍须为项目本体选择许可并补齐 LICENSE/NOTICE。桌面预检会在所有环境变量覆盖之前递归扫描全部 Tauri resources，以 `desktop_bundle_contains_runtime_assets` 拒绝模型权重、KouboRuntime tar、明确 HeyGem/Duix runtime 目录及其中的 Linux `.so`；普通 Node backend 和一般 Node 原生依赖继续允许。当前不自动下载或重新打包授权证据不完整的 HeyGem/Duix/Hack 资产；Duix 当前协议中的归属、用户协议披露和 1,000 月活条件必须在未来运行包获准分发前单独落实。
- `managed_wsl` 的 `compatible_render` 已形成 Windows/WSL 路径闭环：adapter 对现有音频和上传形象执行真实路径解析与 workspace containment，对随机候选输出校验规范父目录，再统一映射为 `/mnt/<小写盘符>/...` 并声明 `wsl_mount_v1`。相对、盘符相对、UNC、设备/扩展、ADS、NUL 和链接越界路径会在网络请求前拒绝。运行时 `outputPath` 只有与本次请求候选 WSL 路径逐字完全相同时才被接受并映射回应用持有的 Windows 候选；也可返回受限 HTTP(S) `resultUrl`，不会借用用户配置的 `resultRoot` 猜测托管路径。ffprobe、同步、原子发布和失败清理仍由主应用负责。
- `KouboRuntime` 的产品主引擎已纠正为项目原始 Duix/HeyGem 链路：现有 `duix_face2face` API、任务恢复、结果校验和 workspace lineage 保持不变；WSL2 只承载免 Docker 的 HeyGem Linux/Python runtime，并通过固定 loopback `compatible_render` 协议接入。
- 已删除偏离产品方向的替代引擎实验源码、模型清单、依赖和测试；`runtime/koubo-heygem` 是唯一托管数字人 bridge。HeyGem 模型与 `.so` 在再分发授权证据完整前继续 fail-closed。
- KouboRuntime 的数字人中间 MP4 使用 FFmpeg 内置 `mpeg4` 编码，最终发布 H.264 由主应用本地剪辑模块统一生成；运行包不再依赖 libx264/GPL 构建。

## Runtime 关键规则

IndexTTS2：UI 只提交文案和音色/参考音频 id。adapter 负责路径解析、参数、超时、取消和错误分类；结果音频必须存在、非空、可被 ffprobe 读取，并关联当前已确认文案。

Duix/HeyGem：UI 只提交声音产物和形象素材 id。adapter 负责上传或 URL 映射、任务提交、轮询、超时和结果复制；结果视频必须有效，并关联当前声音产物。

ffmpeg：是手动剪辑和 Agent 精剪共用的唯一执行核心，首批支持画幅、字幕、音量、背景音乐、片头片尾、封面和 MP4 导出。所有计划先校验再执行。

Tauri：开发使用 `pnpm desktop:dev`。生产包由 Tauri 启动仅监听本机的 Next standalone 后端，进程生命周期跟随桌面应用。UI 始终通过统一 API client 调用，不能因桌面打包把业务逻辑下沉到 React 页面。

## 浏览器发布

首批只支持抖音和小红书：

```text
选择最终成片
→ 生成标题、正文和标签
→ 打开平台发布页
→ 用户监督登录、扫码、验证码和账号选择
→ 自动选择视频并填写表单
→ 停在最终提交前
→ 用户监督并确认最终提交
```

应用不得保存平台密码，也不得绕过验证码或风控。真实发布只能在用户在场并明确授权时执行。平台 DOM 和选择器只能存在于各平台 adapter。

## 常用命令与验证

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm desktop:dev
pnpm desktop:build
pnpm smoke:standalone-upload
```

`pnpm dev` 与 production/desktop build 共用 `.next`，不得并行运行；并行写入会破坏 Turbopack 开发缓存。

最小验证标准：

- 文档或删除切片：引用扫描和 `pnpm typecheck`。
- UI 切片：类型检查和关键页面浏览器验证。
- 模块切片：模块接口测试和失败路径测试。
- 媒体切片：产物存在/非空、ffprobe 和关联一致性。
- 桌面切片：`pnpm build` 和对应桌面 smoke。
- 发布切片：可见浏览器走到最终提交前；真实最终提交由用户监督。

真实 runtime 的密钥和本机路径只写入被忽略的本地环境文件，不提交账号、密码、cookie、session、验证码或 token。轻量化期间每个 diff 应独立可理解和验证，不把删除、状态迁移、UI 重做与发布自动化混成一次大改。
