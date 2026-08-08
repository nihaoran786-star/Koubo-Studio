# Windows 桌面端打包说明

当前项目使用 Tauri 2 打包 Windows 桌面端应用。

## 为什么使用 Tauri

- 比 Electron 更轻量。
- 使用 Windows 系统 WebView2 渲染前端。
- 前端通过 Next.js 静态导出后内置到桌面应用中。
- 适合当前纯前端原型阶段。

## 常用命令

```bash
pnpm desktop:dev
pnpm desktop:build
```

## 构建产物

执行 `pnpm desktop:build` 后会生成：

```text
src-tauri/target/release/koubo-agent.exe
src-tauri/target/release/bundle/nsis/口播智能体_0.1.0_x64-setup.exe
```

## 构建流程

桌面构建会先执行：

```bash
pnpm build:desktop:web
```

该命令会设置 `NEXT_DESKTOP_EXPORT=1`，让 Next.js 只在桌面打包时静态导出到 `out/`。普通开发命令 `pnpm dev` 不受影响。

## 注意事项

- Windows 端需要 WebView2 Runtime。Windows 11 通常已内置。
- 当前只是桌面壳封装，不包含后端、数据库、TTS 或数字人本地服务。
- 当前应用图标是临时极简图标，后续可替换为正式品牌图标。
- 如果后续接入本地进程、文件系统或模型服务，需要通过 Tauri command/permission 设计明确 adapter 层，不能让 UI 直接调用底层命令。

