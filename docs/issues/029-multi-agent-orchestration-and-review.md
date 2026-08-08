# Issue 029 - 多智能体编排、审查和纠错机制

## What to build

建立文本、后期、发布三个 agent 的编排机制，并加入审查/纠错流程。允许后续使用子代理并行开发，但主流程必须负责审查、纠错和合并。

## User pain

多智能体如果没有父子 session、artifact 引用和审查机制，会变成多个聊天上下文互相污染，难以回溯哪个 agent 生成了哪个结果。

## Acceptance criteria

- [ ] 主 session 只保存路由、计划、摘要和 artifact 引用。
- [ ] 子 agent 有独立 session 和 `parentSessionId`。
- [ ] 子 agent 输出必须绑定 artifact。
- [ ] 审查 agent 或 review step 能检查 artifact 和阶段结果。
- [ ] 并行子代理结果不能直接覆盖用户确认内容。
- [ ] 失败或冲突时能回到明确的 correction task。

## Blocked by

- Issue 022
- Issue 024
- Issue 027
- Issue 028

