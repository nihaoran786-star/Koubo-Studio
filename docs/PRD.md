# 口播智能体前端原型优化 PRD

## Problem Statement

当前前端原型已经覆盖了真实业务需要：发布视频和未发布视频管理、多音频和多视频管理、文本编辑、AI 协同操作，以及从文案到发布包的生产流程。

问题不在于是否需要工作台，而在于现有样式和交互表达仍偏普通内容管理后台：作品卡片过重、封面视觉占比过大、导航语言偏通用 SaaS、AI 协同入口不够明确，导致产品气质没有稳定落在“AI 短视频生产工作台”上。

目标是保留 Dashboard / Library / Management 的业务承载能力，同时把视觉和交互从“作品卡片后台”优化为“AI 视频生产控制台”：专业、克制、轻量、可管理、可协同。

## Solution

保留当前的管理层和 Create Flow 双结构，但重新定义它们的视觉层级：

- 管理层用于承载视频资产、音频资产、发布状态、历史作品、数据概览和继续编辑。
- Create Flow 用于承载单条视频的生产流程，包括文案、声音、数字人、成片、发布包。
- Dashboard 不再表现为内容平台式卡片墙，而是表现为生产控制台。
- 作品卡片降级为紧凑资产行、媒体条或轻量项目单元。
- 首页视觉中心从“最近作品封面”转向“当前生产任务 / 继续创作 / 待处理状态”。
- AI 协同能力在关键位置显性化，但不堆满按钮。
- 整体样式从大圆角、重卡片、强玻璃、发光科技感，收敛到留白、细线、低噪声状态、精确动效。

## User Stories

1. As a 内容创作者, I want to quickly see which videos are still being edited, so that I can continue unfinished work without searching.
2. As a 内容创作者, I want to distinguish draft, editing, pending publish, and published videos, so that I can manage production status clearly.
3. As a 内容创作者, I want to see the current step of each video, so that I know whether it is waiting for script, voice, avatar, render, or publish.
4. As a 内容创作者, I want to continue editing a project from the dashboard, so that I do not need to restart the creation flow.
5. As a 内容创作者, I want the dashboard to feel like a production control panel, so that the app feels professional rather than like a content feed.
6. As a 内容创作者, I want video thumbnails to help identify projects without dominating the layout, so that management information stays readable.
7. As a 内容创作者, I want compact project rows or lightweight media items, so that I can scan many videos efficiently.
8. As a 内容创作者, I want clear AI actions near the current task, so that I can ask AI to rewrite scripts, generate voice, or prepare publish copy quickly.
9. As a 内容创作者, I want AI actions to appear progressively, so that the interface does not become crowded.
10. As a 内容创作者, I want text editing to remain convenient, so that I can manually control scripts instead of relying on black-box generation.
11. As a 内容创作者, I want script sections to be structured, so that title, hook, body, subtitles, platform copy, and tags can be edited independently.
12. As a 内容创作者, I want each script sentence to show estimated speaking time when relevant, so that I can control short-video duration.
13. As a 内容创作者, I want voice assets to be managed separately, so that I can reuse cloned voices and preset voices across projects.
14. As a 内容创作者, I want video assets to be managed separately, so that generated clips, previews, covers, and final exports are easy to find.
15. As a 内容创作者, I want published and unpublished videos to have different visual states, so that operational priorities are obvious.
16. As a 内容创作者, I want the publish package to show platform-specific readiness, so that I know what can be copied or exported.
17. As a 内容创作者, I want the app to support Douyin, Xiaohongshu, and Video Account publishing packages, so that I can prepare content for multiple platforms.
18. As a 内容创作者, I want mobile management screens to stay scannable, so that I can check project status on a small screen.
19. As a 内容创作者, I want the mobile layout to avoid oversized cards, so that one project does not consume the whole screen.
20. As a 内容创作者, I want the top navigation to match the production workflow, so that I understand where to manage creation, assets, publishing, and data.
21. As a 内容创作者, I want the app to feel minimal and precise, so that it looks like a serious AI production tool.
22. As a 内容创作者, I want status labels to be short and consistent, so that Ready, Running, Needs Review, Done, Draft, Editing, Pending, and Published are easy to scan.
23. As a 内容创作者, I want visual effects to be restrained, so that glow, blur, and glass do not distract from the work.
24. As a 内容创作者, I want page transitions to communicate movement through the production process, so that the app still feels high-tech without being noisy.
25. As a 内容创作者, I want failures and incomplete states to be visible, so that I know which step needs manual review.

## Implementation Decisions

- Keep the current two-layer product model: management workspace plus Create Flow.
- Do not remove Dashboard. Reposition it as a production control layer rather than a generic content dashboard.
- Rename or reconsider primary navigation labels so they better match the product model. Candidate groups:
  - Production / Assets / Publish / Insights
  - Flow / Library / Publish / Data
  - 生产 / 资产 / 发布 / 数据
- Make the default dashboard hierarchy:
  - current active production task
  - pending review or pending publish items
  - compact recent projects
  - secondary data signals
- Reduce large project cards. Prefer compact media rows, split media strips, or lightweight project units.
- Keep thumbnails, but use them as identifiers rather than the dominant visual element.
- Preserve video status management for draft, editing, pending publish, and published.
- Preserve multi-audio and multi-video management as first-class asset concepts.
- Make AI collaboration actions contextual:
  - continue editing
  - rewrite script
  - generate voice
  - test mixed Chinese-English speech
  - generate avatar
  - render preview
  - prepare publish package
- Do not expose all AI actions at once. Use selected project state, hover, focused row, or detail panel to reveal secondary actions.
- Keep the Create Flow as a step-by-step production surface.
- The Create Flow can remain visually lighter than a full editor, but text editing must remain practical.
- Device detection should remain accessible, but its placement should not conflict with management needs.
- Reduce decorative glassmorphism, heavy glow, large shadows, and repeated rounded cards.
- Use Apple-like visual language: light surfaces, generous whitespace, thin dividers, quiet contrast, precise state feedback.
- Avoid making the app look like a chat bot. AI should behave as an assistant inside production surfaces, not replace the whole UI.
- Avoid turning the app into a full Premiere-like editor. Focus on short-video oral presentation workflows.

## Testing Decisions

- This PRD is primarily a UX and frontend interaction refinement. Testing should focus on externally visible behavior.
- Visual regression screenshots should cover:
  - desktop dashboard
  - mobile dashboard
  - create flow script page
  - create flow voice page
  - project management list with mixed statuses
  - publish package page
- Responsive checks must verify:
  - no clipped navigation text
  - no clipped action labels
  - project list remains scannable on mobile
  - primary action remains visible
  - status labels do not wrap awkwardly
- Interaction checks should verify:
  - selecting a project exposes the right contextual AI actions
  - continuing a project opens the correct create step
  - status filters do not hide necessary information
  - keyboard navigation in Create Flow still works
- Accessibility checks should verify:
  - buttons have clear accessible names
  - focus states are visible
  - status is not communicated by color alone
  - contrast remains readable on light surfaces
- Avoid tests that assert internal component structure. Test what the user can see and do.

## Out of Scope

- Backend implementation.
- Real database or storage integration.
- Real TTS, voice cloning, digital human, rendering, or publishing API integration.
- Full video editor timeline.
- Automatic platform publishing.
- Replacing the current business model with a pure six-step-only app.
- Removing asset management, published/unpublished management, or AI collaborative editing.

## Further Notes

The product should not become a plain chat generator. It should feel like a controlled AI production system:

- users can manage many works
- users can enter a guided creation flow
- AI can assist at each step
- every step remains editable
- published and unpublished states are visible
- audio and video assets are reusable
- the interface remains calm, precise, and production-oriented

The next design pass should optimize style and interaction first, not business structure. The safest first implementation slice is:

1. Reduce dashboard card weight.
2. Rework project list density and hierarchy.
3. Rename navigation to production-oriented labels.
4. Make AI actions contextual.
5. Fix mobile clipping and oversized project cards.
6. Reduce glass, glow, and heavy rounded-card styling.

## Confirmed Visual Reference

用户已确认 `数字人口播最新` 参考包的方向可用。后续视觉和交互改造以该参考包为主要基准：

```text
C:\Users\17949\Documents\应聘\数字人口播最新\stitch_
```

采用其浅色、居中、低噪声、轻卡片、蓝色主操作和“一页一个核心动作”的方向；同时保留当前产品必须具备的多视频管理、多音频管理、发布状态管理、文本编辑便捷性和 AI 协同操作。
