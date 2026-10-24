# Round 4 / Agent B — long-transcript performance (measured 2026-10-24)

IMPROVEMENT_PLAN.md §5: "Measure long-transcript rendering and snapshot/storage
overhead before choosing virtualization, event deltas, or a database migration."
All numbers below are measured on one machine with synthetic fixtures; nothing
is extrapolated except the one row explicitly labelled *extrapolation*.

- Script: `scripts/transcript-perf.mjs` (`node scripts/transcript-perf.mjs [--quick]`)
  — builds isolated workspaces under the OS temp dir (`/tmp`, tmpfs);
  `~/.config/Relay` is never read or written.
- Raw output of the full run quoted here (2026-10-24 ~03:44–03:48 UTC).
- Renderer numbers use the **real** `src/features/conversation/Markdown.tsx`
  bundled by esbuild and mounted with `react-dom/server` (`renderToString`) and,
  for the re-render test, `react-dom/client` in jsdom. No Electron, no dist build.

## Machine and conditions

| | |
|---|---|
| host | FlowZ13 |
| CPU | AMD Ryzen AI MAX+ 395 w/ Radeon 8060S, 32 cores |
| RAM | 124.9 GiB (workspace dir on tmpfs) |
| Node | v24.22.0, kernel 7.3.0-5-cachyos |

Caveats, stated honestly: the shared model runtime was resident and served my
own session's requests between benchmark commands, so rows carry some CPU
contention noise (median-of-3/5 used to damp it). `renderToString` is a
**fresh-render proxy**: it includes markdown parsing and element creation but
not DOM diff/paint. Fixture messages average ≈ 4.5 KB stored (realistic
thinking + 2–10 tool records + code blocks); real transcripts vary.

Fixture ramp: 10 sessions × {25, 250, 1000} turns (transcript scaling) and
{10, 100, 500} sessions × 25 turns (session scaling), plus a 100 × 250 cross
case. A "turn" stores one user + one assistant message, so 10×1000 turns =
the assignment's 2,000-message transcript. 500 sessions × 2,000 messages
(≈1 GB JSON) was **not run** (would cost minutes of I/O per data point).

## 1. Main process: storage and snapshot, vs total stored data

Median times, per scenario (`STORE` rows; "payload" = per-`changed` IPC snapshot,
which is the whole workspace plus pools):

| sessions | messages | workspace.json | Store open (load+save) | pure load | `save()` | snapshot `structuredClone` | IPC payload | snapshot `JSON.stringify` |
|---|---|---|---|---|---|---|---|---|
| 10 | 500 | 2.3 MB | 8.2 ms | 2.9 ms | 3.1 ms | 4.4 ms | 2.3 MB | 1.5 ms |
| 10 | 5,000 | 22.5 MB | 84 ms | 24 ms | 33 ms | 49 ms | 22.5 MB | 17 ms |
| 10 | 20,000 | 90.7 MB | 335 ms | 100 ms | 184 ms | 220 ms | 90.7 MB | 84 ms |
| 100 | 5,000 | 22.6 MB | 72 ms | 19 ms | 32 ms | 46 ms | 22.6 MB | 15 ms |
| 500 | 25,000 | 113.5 MB | 390 ms | 115 ms | 234 ms | 274 ms | 113.5 MB | 108 ms |
| 100 | 50,000 | 226.9 MB | 885 ms | 228 ms | 497 ms | 585 ms | 226.9 MB | 215 ms |

**Every cost is linear in total stored bytes** — and "total" means *all
sessions*, because `save()`, `snapshot()` and the IPC payload serialize the
entire `workspace.json` data tree regardless of which session changed.
`save()` also pays `copyFileSync → .bak` + full tmp write + rename (≈3× file
I/O per save; time includes it).

*Extrapolation (not measured):* 500 sessions × 2,000 messages ≈ 1 GB → open
≈ 4 s, save ≈ 2 s, snapshot ≈ 2.6 s per change.

## 2. The per-token streaming path (the important section)

Real `AgentService` with a fake runner emitting 240 deltas at 25 ms intervals
(≈40 tok/s, matching this runtime's observed decode rate). `changed` events
are the 70 ms-throttled full snapshots that go to the renderer (`emit →
changed() → snapshot() → webContents.send`).

| workspace (all sessions) | payload | `changed` rate observed | snapshot+clone per event | `store.save()` during stream (every 700 ms) | stream wall (240 deltas, floor 6.0 s) |
|---|---|---|---|---|---|
| 1 session × 50 msgs | 0.24 MB | **13.3 Hz** (throttle works) | 0.43 ms | 0.65 ms × 12 | 6.16 s |
| 10 sessions × 500 msgs | 23.6 MB | **10.5 Hz** (can't keep up) | 45 ms | 38.7 ms × 14 | 8.15 s |
| 10 sessions × 2,000 msgs | 95 MB | **5.25 Hz** (⅓ of target) | 209 ms | 120 ms × 22 | **15.9 s** |

Per streamed token at the runtime's ≈40 tok/s (labelled derived):

| workspace | main-process ms per token (snapshot+stringify+save) |
|---|---|
| 0.24 MB | ≈ 0.04 ms |
| 23.6 MB | ≈ 2.8 ms |
| 95 MB | ≈ **13–38 ms** (the event loop can't even produce all frames) |

Three independent saturation signals at 95 MB: `changed` rate falls 13.3 → 5.25 Hz;
the 700 ms `save()` costs 120 ms each (17% of main-thread time); and the runner's
own `setTimeout(25ms)` stream takes 15.9 s instead of 6.0 s because the main
event loop is starved by snapshot + save work.

**What does NOT cost per token:** inside `emit`, the only per-delta compute is
`updateTiming()`'s eager `answer.content + answer.thinking` and `finalizeRate`.
Measured (microbench replication): concat of a 512 KB combined answer =
0.011 µs, `finalizeRate` = 0.018 µs — V8 builds ConsStrings lazily, so the
per-delta path is O(1) and irrelevant. No fix warranted there.

## 3. Renderer (measured with the real Markdown component)

Fresh `renderToString`, warm module, median of 2:

| single message | with code blocks (hljs on) | same length, no code | notes |
|---|---|---|---|
| 2.3 KB | 4.3 ms | 1.9 ms | |
| 9 KB | 8.1 ms | 3.0 ms | |
| 32 KB | 14.4 ms | 10.8 ms | markdown parse dominates hljs |
| 97 KB | 34.1 ms | 28.6 ms | >50 KB: highlight skipped by design |

| message list (all messages rendered) | stored chars | fresh render |
|---|---|---|
| 50 messages | 96 KB | 48 ms |
| 500 messages | 942 KB | 391 ms |
| 2,000 messages | 3.82 MB | 1,439 ms |

Rendering is linear at ≈0.7 ms per message (~0.4 ms/KB of markdown). Before the
fix described below, `MessageView`/`Markdown` were unmemoized and every
`changed` event (70 ms target, ~14 Hz) re-rendered **every message in the open
transcript**, i.e. a 500-message transcript demanded ~391 ms × 14 Hz ≈ 5.5 s of
renderer CPU per second of streaming — impossible; this is why typing feels
laggy long before storage is noticeaby slow.

## 4. Fix made, with before/after

Measured hotspot with an obvious, low-risk remedy: unchanged messages
re-parsing their markdown on every snapshot. `src/features/conversation/Markdown.tsx`
(not a shared file, no lock needed) now exports a `React.memo`ized `Markdown`
(7-line diff). `tests/markdown_memo.test.mjs` mounts the real component in
jsdom, renders 30 fixture messages, then performs a parent re-render with
byte-identical content (exactly what a `relay:changed` event for another
session produces):

| | first render | no-op re-render | ratio | test |
|---|---|---|---|---|
| before | 135.8 ms | 100.2 ms | 0.74 | fail (asserts ratio < 0.35) |
| after | 116.7 ms | **2.0 ms** | **0.02** | pass |

Checks after fix: `node --test tests/*.test.mjs` → 145/145 pass;
`npx tsc --noEmit` → clean. GUI check left to the reviewer (no Electron runs
allowed this round): during a streamed turn, scrolling and the growing message
should render; previously every frame re-parsed the entire transcript.

## 5. What grows linearly per streamed token — the finding

- Per **delta**: nothing meaningful (O(1), ≈0.03 µs). ✓ measured
- Per **changed frame (70 ms throttle)**: `structuredClone(all sessions)` +
  IPC serialization + renderer re-render — all linear in **total store bytes
  across every session**, not in the streaming session. At 40 tok/s this is
  ~14 × (clone+stringify) ms per second: it exceeds one core already at ~25 MB
  (measured: 10.5 Hz) and starves the event loop at ~100 MB (5.25 Hz, stream
  wall-time 2.6× the floor).
- Per **700 ms save**: full JSON serialization + 3× file I/O of the whole
  workspace, linear in total bytes (120 ms at 90 MB, 497 ms at 227 MB).
- Per **renderer frame**: before the fix, linear in transcript size; after the
  fix, only the streaming message re-parses (still linear in *its current
  length*: a 32 KB in-progress message costs 14 ms/frame ≈ 200 ms/s at 14 Hz;
  acceptable, 100 KB costs ~34 ms/frame ≈ 48% of a core).

## 6. Recommendation (evidence-based)

1. **Event deltas / scoped payloads first** (not virtualization, not a DB):
   the dominant per-frame cost is cloning + IPC-ing all sessions' transcripts
   on every change (`snapshot()` = whole store). Options: send only changed
   sessions/message tails on `relay:changed`, or omit message bodies of
   non-selected sessions and fetch the open transcript on demand. This removes
   the per-token cost growth *and* the 95 MB wall.
2. **Then** storage: throttle `save()` by data growth instead of fixed 700 ms,
   and/or split persistence per session so a save isn't a full-workspace
   rewrite (0.65 ms is fine at 240 KB; 120–500 ms is not at 90–227 MB). A
   database migration is not yet justified — load/save are linear and only hurt
   at sizes that deltas alone would make irrelevant.
3. **Virtualize the list last**: only needed for the first render/scroll of
   very long transcripts (1.4 s at 2,000 messages); after memoization it is no
   longer a per-frame streaming cost.
4. No fix needed: `emit` per-delta path, `finalizeRate`, highlight.js threshold.

## Reproducing

```
node scripts/transcript-perf.mjs          # ~4 min, writes only under /tmp
node scripts/transcript-perf.mjs --quick  # ~40 s smoke
node --test tests/markdown_memo.test.mjs
```
