# Agent B — Round 4 report: long-transcript performance measurement

Status: complete. Measurement-first per the assignment; one small fix made
because a measured hotspot had an obvious, low-risk remedy.

## Changes / files

| File | What |
|---|---|
| `scripts/transcript-perf.mjs` | **new** — synthetic-workspace benchmark: 10/100/500 sessions × 50/500/20,000-message transcripts (temp dir only, `/tmp` tmpfs; never touches `~/.config/Relay`), measuring `Store` load, `save()` time + file size, snapshot construction + IPC payload size/serialization, a real streamed turn through `AgentService` (throttled `changed` rate, per-700 ms save cost, event-loop starvation), per-delta microbenches, and renderer cost via esbuild-bundled **real** `Markdown.tsx` + `react-dom/server` (jsdom for the re-render test). `--quick` smoke mode included. |
| `src/features/conversation/Markdown.tsx` | **fix (7 lines)**: `Markdown` is now `React.memo`ized — unchanged messages no longer re-parse their markdown on every ~70 ms workspace snapshot. Not a shared file → no lock needed; no shared file was edited. |
| `tests/markdown_memo.test.mjs` | **new** — regression for the fix: mounts the real component in jsdom, asserts correct rendering (headings, hljs, lists) and that a parent re-render with byte-identical content is ≥2.9× cheaper than the first render (assert ratio < 0.35; measured 0.02). |
| `coordination/round4/B.perf.md` | **new** — full results: machine, method, tables, derived per-token costs (labelled), caveats, recommendation. |
| `coordination/round4/B.rates.md` | token-rate log (3 phases). |

## Key measured findings (FlowZ13, Ryzen AI Max+ 395, 125 GiB, Node 24; tmpfs)

- `save()`, `snapshot()` and the `relay:changed` IPC payload are **linear in
  total stored bytes across ALL sessions** (2.3 MB→113 MB store: save 3→234 ms;
  snapshot clone 4→274 ms; 100×250 msgs = 227 MB → save 497 ms, snapshot 585 ms).
- Streaming path saturates at realistic sizes: with a 95 MB workspace, the
  70 ms-throttled `changed` rate measured **5.25 Hz vs 13.3 Hz** at 240 KB,
  per-event snapshot 209 ms, `save()` 120 ms every 700 ms, and a 6 s fake
  stream took **15.9 s** (main event loop starvation). At ≈40 tok/s this is
  ≈13–38 ms of main-process work **per streamed token**, growing linearly with
  total store bytes regardless of which session streams.
- Per-delta work inside `emit` (`updateTiming` concat + `finalizeRate`) is
  **O(1), ~0.03 µs** — not a hotspot; deliberately not "fixed".
- Renderer: fresh render ≈0.7 ms/message (500 msgs = 391 ms; 2,000 = 1.44 s);
  markdown parse dominates highlight.js; the 50 KB highlight skip works.
  Before the fix every `changed` frame re-parsed the whole transcript
  (measured no-op re-render ratio 0.74); **after: 0.02** (100.2 ms → 2.0 ms
  for a 30-message list).
- Recommendation (in B.perf.md §6): **event deltas / scoped snapshot payloads
  first**, then save throttling/per-session persistence, virtualization last.
  A DB migration is not yet justified by the numbers.

## Checks

| Check | Result |
|---|---|
| `node scripts/transcript-perf.mjs --quick` | pass |
| `node scripts/transcript-perf.mjs` (full matrix) | pass; output captured in B.perf.md |
| `node --test tests/markdown_memo.test.mjs` — before fix | **fail as designed** (ratio 0.74; demonstrates the hotspot) |
| `node --test tests/markdown_memo.test.mjs` — after fix | pass (ratio 0.02) |
| `node --test tests/*.test.mjs` (all 145 backend tests) | pass 145/145 |
| `npx tsc --noEmit` | pass |
| Electron acceptance / GUI run | **not run** (prohibited this round) |
| 500 sessions × 2,000 messages (~1 GB) | **not run** (cost); linear fits quoted as extrapolation only |

## Limitations

- `renderToString` is a fresh-render proxy (no DOM diff/paint); jsdom client
  test covers the re-render path but still not paint.
- Shared runtime + my own model requests ran between benchmark commands, so
  medians carry some contention noise; no attempt to isolate cores was made.
- Attribution of runtime.log rate rows: see B.rates.md notes.
- Snapshot-cost proxy for `webContents.send` is `structuredClone` +
  `JSON.stringify` in Node; real Electron IPC costs may differ modestly.

## Remaining work (suggested, not started)

1. Per-session / delta `relay:changed` payloads (drop whole-store clone+IPC).
2. Growth-based save throttling or per-session persistence files.
3. Optional list virtualization for very long transcripts (first-render only).

## GUI validation steps (reviewer)

1. Open a session with a long transcript, start any streamed turn in it.
2. Confirm streamed text renders incrementally; code blocks still highlight;
   artifact-source `<details>`, HTML preview and Copy buttons unchanged.
3. Scroll up during streaming: should be noticeably smoother than before with
   multiple/long sessions.
4. Switch sessions mid-stream: content renders identically (memo compares the
   message string; no stale-content risk since content is a value prop).
5. Check DevTools performance: long react-markdown tasks between `relay:changed`
   events should be limited to the streaming message, not the whole transcript.
