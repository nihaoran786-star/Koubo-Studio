# Issue 094 - Settings Return To Active Create Flow

Status: Done

## What to build

当用户从 Create Flow 阶段 runtime readiness notice 点击“打开设置”后，设置页需要保留返回上下文，并允许用户回到同一个项目、同一个创作步骤继续操作。

## User pain

Issue 093 已经让声音、数字人、后期、发布步骤能提前看到当前 runtime 缺配置，并提供“打开设置”入口。但当前 Web 导航模型里，点击设置后没有可靠入口返回正在编辑的 Create Flow 项目和步骤。用户修完配置后容易丢失工作流位置，E2E 目前只能验证按钮可见，不能验证完整往返。

## Architecture boundary

- `CreateFlowApp` 可以发起“打开设置”的导航意图，但不应把 settings 的返回逻辑硬编码成环境判断。
- 需要一个明确返回状态模型，例如 `returnToCreate?: { projectId: string; chamberId: ChamberId }`。
- 设置页只渲染返回入口，不读取 workspace 文件、不读取 env、不执行 smoke。
- 返回动作必须恢复同一项目和同一 active chamber，不能创建新项目或重置流程。
- Runtime readiness API 仍是唯一运行环境数据来源。

## Acceptance criteria

- [x] 从任一 Create Flow 阶段点击“打开设置”时，保留当前 `projectId` 和 `chamberId`。
- [x] 设置页只在存在返回上下文时展示“返回当前创作”或同等入口。
- [x] 点击返回后恢复同一项目、同一 active chamber。
- [x] E2E 覆盖：声音页看到 IndexTTS2 缺配置提示，点击“打开设置”，确认进入设置页运行环境区域，再点击返回并回到声音步骤。
- [x] 返回后仍能看到同一阶段控件和 runtime notice，不出现新项目、空项目或错误步骤。
- [x] UI 不直接读取 env、文件路径或执行 runtime smoke。

## Implementation notes

- 新增 `return-to-create` 状态 helper，用 `projectId` 和 `chamberId` 显式校验返回目标。
- `CreateFlowApp` 在从创作步骤打开设置时保存返回目标，并在返回时恢复同一项目和同一 chamber。
- `SettingsPage` 只接收可选返回动作并渲染按钮；设置页不读取 workspace 文件、env 或执行 smoke。

## Verification

- `pnpm vitest run lib/create-flow/return-to-create.test.ts`
- `pnpm test:e2e tests/e2e/pipeline-visual-sweep.spec.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

## Blocked by

- 无。真实 runtime 仍由 Issue 091 准备；本 issue 只解决设置页与当前创作流程的导航连续性。
