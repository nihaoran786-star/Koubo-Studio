# Issue 073 - Script Artifact Approval API

Status: Done

## What to build

把“确认文案”从纯前端 draft 状态同步到后端 script artifact。用户点击确认后，前端应调用 script-agent API，把对应 `script` artifact 的 `approvalStatus` 更新为 `approved`，并把 artifact index 状态更新为 `ready`。

## User pain

Issue 072 已经让文案页必须先确认才能进入音频，但确认状态只存在前端 workspace draft。刷新、恢复或后续服务读取 artifact 时，后端仍可能看到 `draft`。这会让“已确认文案”缺少可信的 workspace 证据。

## Architecture boundary

- UI：只调用 approve API 并渲染 `approvalStatus`。
- Hook/client：负责 `PATCH /script-agent` 请求和失败状态。
- Route/service：负责校验 `artifactId`、定位 project workspace、更新 script artifact。
- Artifact：唯一写入 `approvalStatus` 和 artifact index 状态。
- External system：不调用 Pi，不重新生成文案。

## Acceptance criteria

- [x] `script` artifact 支持更新 `approvalStatus`。
- [x] 更新为 `approved` 时 artifact index 状态为 `ready`。
- [x] `PATCH /api/projects/:projectId/script-agent` 支持确认已有 artifact。
- [x] client/hook 支持 `approveDraft()`。
- [x] 文案页点击“确认文案”时先调用后端 approval API。
- [x] 后端确认成功后才把本地 draft 标成 `approved`。
- [x] 确认失败时保留 `draft`，并在聊天中显示错误。
- [x] 单测覆盖 artifact 更新、route PATCH、client PATCH。
- [x] E2E 覆盖确认文案后进入音频/发布主路径。

## Implementation notes

- `lib/artifacts/script-artifact.ts` 新增 `updateScriptArtifactApproval()`。
- `lib/agents/script-agent-service.ts` 新增 `approveScriptArtifactForProject()`。
- `lib/agents/script-agent-route-handler.ts` 新增 `handleScriptAgentPatch()`。
- `app/api/projects/[projectId]/script-agent/route.ts` 暴露 `PATCH`。
- `lib/agents/script-agent-client.ts` 从单函数 client 扩展为 `generate/approve` 两个方法。
- `components/create-flow/idea-chamber.tsx` 的确认按钮现在通过 `scriptAgent.approveDraft()` 同步后端。

## Verification

- `pnpm vitest run lib/artifacts/script-artifact.test.ts lib/agents/script-agent-client.test.ts lib/agents/script-agent-route-handler.test.ts`
- `pnpm typecheck`
- `pnpm test:e2e -- tests/e2e/script-page.spec.ts -g "script page writes|voice page submits|publish page submits"`

## Blocked by

- Issue 072

## Notes

后续可以继续收敛：让音频 API/service 强校验 script artifact 必须是 `approved`，而不是只依赖前端步骤推进。
