# 101 - Digital human chain real runtime smoke

## Status

Completed

## Goal

Prove the real digital-human generation chain with one trusted artifact lineage:

```text
approved script artifact -> IndexTTS2 audio artifact -> HeyGem/Duix render artifact
```

This closes the gap where `pnpm smoke:indextts2` and `pnpm smoke:heygem-runtime` can pass independently while no single generated audio artifact is consumed by the real digital-human service.

## Scope

- Add a gated real runtime smoke: `pnpm smoke:digital-human-chain`.
- Add a preflight that reports missing runtime config before Vitest starts.
- Add a runtime doctor readiness row for the full digital-human chain, separate from the standalone IndexTTS2 and HeyGem/Duix checks.
- Use `generateIndexTTS2Audio()` and `generateHeyGemRender()` service boundaries.
- Require `DUIX_AVATAR_INTEGRATION_AVATAR_ASSET` in `duix_face2face` mode.
- Reject `duix_face2face` runtime submissions that only provide a library avatar id or a non-video avatar asset.
- Probe the Duix face2face route before real smoke execution, so a reachable but wrong HTTP service fails before task submission.
- Delete the smoke workspace after the test.

## Acceptance

- With `RUN_DIGITAL_HUMAN_CHAIN_SMOKE=1` and real runtime env configured, the smoke writes a ready audio artifact and a ready render artifact.
- The render artifact references the audio artifact generated in the same test.
- The audio artifact references the approved script artifact generated in the same test.
- Default test runs skip the real smoke unless explicitly enabled.
- Missing runtime config fails during preflight with a stable reason.
- `duix_face2face` adapter calls fail before task submission unless the avatar is backed by an uploaded MP4/MOV/AVI/MKV/WebM asset.
- `pnpm smoke:heygem-runtime` preflight checks `GET /easy/query?code=__koubo_preflight__` in `duix_face2face` mode before validating media inputs.
- The avatar page defaults to uploaded video assets for real generation and keeps library avatars as preview/management only.
- The voice and avatar services probe uploaded media with ffprobe before launching IndexTTS2 or Duix/HeyGem, so unreadable reference audio or avatar video fails before long-running runtime work starts.
- Real runtime smoke passed on 2026-06-12 with `KOUBO_WORKSPACES_ROOT` inside the Duix host data root.

## Verification

```powershell
pnpm smoke:digital-human-chain
pnpm vitest run lib\digital-human\heygem-adapter.test.ts
pnpm vitest run lib/audio/indextts2-service.test.ts lib/digital-human/heygem-service.test.ts
pnpm vitest run lib/digital-human/digital-human-chain.integration.test.ts
pnpm vitest run components/create-flow/avatar-chamber.test.tsx
pnpm typecheck
```

Latest verified command:

```text
pnpm smoke:digital-human-chain
Digital-human chain smoke preflight passed.
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    109.28s
```

Latest UI guard verification:

```text
pnpm vitest run components/create-flow/voice-chamber.test.tsx components/create-flow/avatar-chamber.test.tsx
Test Files  2 passed (2)
Tests       4 passed (4)
```

Latest Duix preflight guard verification:

```text
pnpm vitest run scripts/heygem-smoke-preflight.test.mjs
Test Files  1 passed (1)
Tests       21 passed (21)
```

Latest Duix/HeyGem segmented runtime verification:

```text
RUN_HEYGEM_INTEGRATION=1 pnpm smoke:heygem-runtime
HeyGem runtime preflight passed: http://127.0.0.1:8383
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    12.55s
```

Latest standalone Duix/HeyGem verification with real chain audio:

```text
pnpm smoke:heygem-runtime
HeyGem runtime preflight passed: http://127.0.0.1:8383
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    20.63s
```

Latest standalone Duix/HeyGem verification after `progress >= 100` query compatibility:

```text
pnpm smoke:heygem-runtime
HeyGem runtime preflight passed: http://127.0.0.1:8383
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    28.09s
```

## Remaining Risk

The distributable desktop path is the managed WSL2 `KouboRuntime`; the app still needs a legally redistributable runtime package before the full digital-human engine can ship inside the free installer. In `duix_face2face` mode the avatar asset must be a real video file, not a still image.

The voice page now requests the latest ready audio by the current `scriptArtifactId`, so the avatar stage should not receive a newer audio artifact generated for another script.

The avatar page now prevents library avatar ids from being used as real Duix/HeyGem generation input, including the case where a user uploads a video and then switches back to "已有形象". A real run still requires an uploaded video asset; the adapter remains the final enforcement layer for file type and runtime submission safety.

The audio service now derives synthesis text from the approved script artifact body instead of trusting caller-provided `parameters.text`, so the audio artifact cannot claim one approved script while synthesizing unrelated text.

Duix face2face result copying now rejects result paths outside `DUIX_AVATAR_RESULT_ROOT` / `HEYGEM_RESULT_ROOT` with `result_path_escape`, so a malformed backend response cannot copy arbitrary local files into the workspace render artifact.

The Duix face2face query parser now also accepts `progress >= 100` with a `result` filename as a completed task, matching Duix/Olares-style responses that do not set `status=2`.

Latest Duix-Avatar upstream check:

```text
duixcom/Duix-Avatar main README still documents face2face submit/query as:
POST http://127.0.0.1:8383/easy/submit
GET  http://127.0.0.1:8383/easy/query?code=...
```

The current adapter already submits `audio_url`, `video_url`, `code`, `chaofen`, `watermark_switch` and `pn`, then polls `easy/query`. The direct gap found in this pass was preflight quality: uploaded avatar videos were checked by extension only. `pnpm smoke:heygem-runtime` now probes `DUIX_AVATAR_INTEGRATION_AVATAR_ASSET` / `HEYGEM_INTEGRATION_AVATAR_ASSET` with ffprobe in `duix_face2face` mode and fails with `avatar_duration_probe_failed` before submitting a long Duix task if the face video has no positive readable duration.

Latest protocol compatibility verification:

```text
pnpm vitest run lib/digital-human/heygem-adapter.test.ts lib/digital-human/heygem-service.test.ts lib/digital-human/heygem-client.test.ts
Test Files  3 passed (3)
Tests       34 passed (34)
```

Latest Duix preflight and real runtime verification:

```text
pnpm vitest run scripts/heygem-smoke-preflight.test.mjs lib/digital-human/heygem-adapter.test.ts lib/digital-human/heygem-service.test.ts lib/digital-human/heygem-client.test.ts
Test Files  4 passed (4)
Tests       56 passed (56)

pnpm smoke:heygem-runtime
HeyGem runtime preflight passed: http://127.0.0.1:8383
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    22.75s
```
