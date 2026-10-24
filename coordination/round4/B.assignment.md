# Agent B — Long-transcript performance measurement

Read `coordination/round4/README.md` first, then IMPROVEMENT_PLAN.md §5 (last paragraph) and the "Scale" row of the "What is already present" table.

Goal: measure, with synthetic data, how Relay's cost grows with long transcripts and many sessions, so the next decision (virtualization, event deltas, or a storage change) is based on numbers. Measurement first; only make a fix if a measured hotspot has an obvious, low-risk remedy.

Starting points (search, don't dump): `electron/store.mjs` (synchronous JSON `save()`), `electron/service.mjs` (`changed()`, the save throttle in `emit`, snapshot construction), `electron/main.mjs` (`snapshot` IPC), `src/App.tsx` message list and `src/features/conversation/Markdown.tsx` (rendering, highlight.js).

Requirements:
1. A script `scripts/transcript-perf.mjs` that builds isolated synthetic workspaces in a temp dir (never the user's `~/.config/Relay`), for example 10/100/500 sessions and transcripts of 50/500/2,000 messages with realistic thinking, tool records and code blocks, and measures with `performance.now()`: `Store` load, `save()` time and file size, snapshot construction and JSON serialization size (the per-change IPC payload), and anything else on the per-token streaming path (e.g. `emit` → `changed()` cost per delta).
2. Renderer cost: measure Markdown/highlight rendering of long messages and the full message list with `react-dom/server` `renderToString` (or jsdom) in Node; no Electron launch, no build.
3. Write the results to `coordination/round4/B.perf.md`: tables, the machine, the method, and which costs grow linearly per streamed token (the important finding). Recommend the next step with evidence.
4. If you fix something, add a regression test under `tests/` and show before/after numbers.
5. Report in `coordination/round4/B.report.md`; rates in `B.rates.md`.
