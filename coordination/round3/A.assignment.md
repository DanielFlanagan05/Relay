# Agent A — Session context usage bar

Read `coordination/round3/README.md` first, then IMPROVEMENT_PLAN.md §2 rows/sections about context usage ("Session context usage and compaction", the P1 row) and LOCAL_AGENT_UTILIZATION.md "Fixes applied" (usage semantics).

Goal: each session shows `<context used> / <context available> tokens` at the bottom-right, immediately above the composer text box, with compaction status.

Starting points (search, don't dump): `src/App.tsx` composer and `SessionInspector` (~lines 1750–1850 already compute context used from `last.usage`), `electron/usage.mjs`, `electron/protocol.mjs` (per-harness usage parsing), `src/types.ts` Message.usage.

Requirements:
1. New component, e.g. `src/features/context/ContextUsage.tsx` + pure logic `contextUsageLogic.ts`. Used = context retained for the next request (last request's input incl. cached input where reported), NOT cumulative turn/lifetime totals. Available = active model's context window. Mark values measured vs estimated vs unavailable/stale explicitly; never show 0 when unknown.
2. Per-session: switching sessions never shows another session's values. Update after turns and when model/context limit changes. Visible while idle, queued and running. No overlap with composer controls at narrow width/200% zoom.
3. Compaction: add optional additive session fields (e.g. `compaction?: { status: 'running'|'done'|'failed'; at: string }`) set only from explicit harness/adapter events you can identify in `electron/protocol.mjs` (e.g. a native compaction event); a token decrease alone is not compaction. Show "Compacting context…", "Context compacted" (with last time on hover/title), or failure; `role="status"`/aria-live announcement. If no harness emits a verifiable event, wire the field and UI, leave detection documented as unavailable.
4. Tests: `tests/context_usage.test.mjs` (or a renderer-logic script) with mock usage: measured, estimated, unavailable, stale, model switch, compaction progress/success/failure, session switching.
5. Report in `coordination/round3/A.report.md`; rates in `A.rates.md`.
