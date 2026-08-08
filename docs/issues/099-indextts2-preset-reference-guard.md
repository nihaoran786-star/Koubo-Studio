# Issue 099 - IndexTTS2 Preset Reference Guard

Status: Done

## What to build

防止声音页把未绑定真实音频文件的 `preset:*` 伪路径传给 IndexTTS2 runtime。真实音频生成必须使用上传后的 workspace audio asset，预设音色只能作为试听/选择入口，不能伪装成参考音频文件。

## Why now

真实 IndexTTS2 wrapper 接收的是本地参考音频路径。此前声音页在“内置音色”模式会提交 `referenceAudioPath=preset:<name>`，adapter 会直接传给 PowerShell 的 `-ReferenceAudio`，这会在真实 runtime 中失败，并让 UI 看起来已经支持预设真实生成。

## Architecture boundary

- UI：引导用户上传参考音频后再生成，不访问文件系统。
- audio service：拒绝未映射到真实文件的 `preset:*`，返回明确 `invalid_request`。
- adapter：只接收 service 校验后的参数，继续作为唯一外部 wrapper 调用层。

## Acceptance criteria

- [x] `generateIndexTTS2Audio()` 在调用 adapter 前拒绝 `referenceAudioPath` 以 `preset:` 开头的请求。
- [x] 声音页预设模式不再直接触发真实生成，而是引导上传参考音频。
- [x] 声音页默认进入上传参考音频路径，`preset:*` 不再作为真实生成参数提交给 IndexTTS2 hook。
- [x] E2E 中需要生成音频的路径都先上传参考音频。
- [x] 不引入假的预设音频路径或硬编码本地素材。
- [x] 情绪参考音频也执行 8-12 秒浏览器预检和 service 端 ffprobe gate，避免长音频进入真实 IndexTTS2 runtime。

## Verification

- `pnpm vitest run lib/audio/indextts2-service.test.ts lib/audio/voice-generation.test.ts lib/audio/indextts2-adapter.test.ts`
- `pnpm test:e2e tests/e2e/script-page.spec.ts`
- `pnpm vitest run components/create-flow/voice-chamber.test.tsx components/create-flow/avatar-chamber.test.tsx`
- `pnpm typecheck`

Latest UI guard verification:

```text
pnpm vitest run components/create-flow/voice-chamber.test.tsx components/create-flow/avatar-chamber.test.tsx
Test Files  2 passed (2)
Tests       4 passed (4)
```

Latest IndexTTS2 parameter and runtime verification:

```text
pnpm vitest run lib/audio/indextts2-service.test.ts lib/audio/voice-generation.test.ts lib/audio/indextts2-adapter.test.ts components/create-flow/voice-chamber.test.tsx
Test Files  4 passed (4)
Tests       24 passed (24)

pnpm smoke:indextts2
IndexTTS2 runtime preflight passed: C:\koubo-runtimes\indextts2\IndexTTS
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    51.48s
```

## Blocked by

- 无。
