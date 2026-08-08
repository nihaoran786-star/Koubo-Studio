# Issue 072 - Script Approval Gate Before Audio

Status: Done

## What to build

文案页必须区分“AI 已生成草稿”和“用户已确认文案”。只有用户点击确认后，才允许进入音频阶段。生成文案后直接进入声音克隆会违反数字人链路 PRD 中的人工确认要求。

## User pain

用户需要在左侧检查标题、开头、正文和平台文案，并可手动编辑。若生成后直接显示下一步，用户可能把未确认或刚编辑过的草稿送入 IndexTTS2，后续音频、数字人、后期和发布都会消费错误文本。

## Architecture boundary

- UI：只渲染 `script.approvalStatus`，显示“确认文案 / 已确认文案 / 下一步”。
- Workspace state：保存本地 draft 的 `approvalStatus`，用于恢复页面状态。
- Audio stage：不承担文案确认判断，只接收已经通过文案页推进的脚本文本。
- Backend artifact：真实 script artifact 仍保留自己的 `approvalStatus`，后续可继续收敛到 workspace-backed 状态。

## Acceptance criteria

- [x] `ScriptDraft` 新增 `approvalStatus: draft | approved`。
- [x] 新生成文案默认为 `draft`。
- [x] 手动编辑、AI 改写、继续聊天会让文案回到 `draft`。
- [x] 文案生成后显示“确认文案”，但不显示“下一步”。
- [x] 点击“确认文案”后显示“已确认文案”和“下一步”。
- [x] E2E 覆盖生成文案后必须先确认，才能进入音频页。
- [x] 现有音频、数字人、后期、发布 E2E 主路径改为显式确认文案。

## Implementation notes

- `lib/workspace.ts` 为 `ScriptDraft` 增加 `approvalStatus`，旧 localStorage 项目会被 normalize 为 `draft`。
- `components/create-flow/idea-chamber.tsx` 新增确认按钮；编辑或改写调用 `patch()` 时回到 `draft`。
- `tests/e2e/script-page.spec.ts` 新增 `approveScript()` helper，并验证文案生成后“下一步”隐藏。

## Verification

- `pnpm typecheck`
- `pnpm test:e2e -- tests/e2e/script-page.spec.ts -g "script page writes|voice page submits|publish page submits"`

## Blocked by

- Issue 035
- Issue 036

## Notes

这是文本智能体到音频阶段之间的产品级 gate。后续可进一步把本地 `approvalStatus` 与 workspace-backed script artifact approval 统一，避免 localStorage draft 和 artifact approval 长期分叉。
