# Issue 036 - 文案页真实 AI 路径 E2E 与截图测试

## What to build

为数字人文案页补 E2E 或截图测试，覆盖真实 script-agent 调用路径、运行中状态、配置缺失提示、解析失败提示和左侧文案写入结果。测试结束后清理截图和测试 workspace，除非失败时需要保留证据。

## User pain

文案页已经接入 script-agent client/hook，但目前只有 client 单元测试和构建验证。没有浏览器级测试，无法证明页面交互、布局、错误提示和左侧文案写入在真实 UI 中正常。

## Acceptance criteria

- [x] 配置 Playwright 或项目内等价浏览器测试方案。
- [x] 覆盖文案页首次输入主题。
- [x] 覆盖点击“生成文案”的 running 状态。
- [x] 覆盖成功响应后左侧标题、hook、正文、平台文案写入。
- [x] 覆盖 `needs_configuration` 提示。
- [x] 覆盖 `script_parse_error` 提示。
- [x] 生成至少一张文案页截图用于调试。
- [x] 测试成功后删除临时截图和测试 workspace。
- [x] 测试失败时保留证据路径并在报告中说明。

## Progress

- 2026-06-11：新增 Playwright 配置和 `pnpm test:e2e`。
- 2026-06-11：新增文案页 E2E，mock `/api/projects/:projectId/script-agent`，覆盖成功、`needs_configuration`、`script_parse_error`。
- 2026-06-11：成功路径会截图到 `test-results/script-page-success.png`，测试通过后删除。
- 2026-06-11：验证通过 `pnpm test:e2e tests/e2e/script-page.spec.ts`、相关 Vitest、`pnpm lint`、`pnpm build`。
- 2026-06-11：确认 `test-results` 和测试 workspace 已清理。

## Follow-up

- Issue 037：完善 Agent Chat 组件，支持 tool/skill 调用展示和 `/` 命令选择 skill。

## Blocked by

- Issue 035
