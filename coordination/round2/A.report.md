# Agent A report — system-wide process memory telemetry + Local compute graph

Timestamp: 2026-10-23. Scope: IMPROVEMENT_PLAN "Local compute: memory usage by process"
(P1) plus the backend telemetry it needs. Mocks/fixtures only.

## What is implemented

Backend (new, mine): `electron/processTelemetry.mjs`
- `collectProcesses({ platform, procRoot, readdir, readFile, systemMemory, ownUid, selfPid, maxEntries })`
  reads one `/proc/<pid>/status` per process: name, state, real UID, `VmRSS` (kB → bytes).
- Lists **all** user-visible processes (browsers, editors, services, model runtimes), one
  record per PID. Same-named processes stay separate. Sorted by measured memory descending,
  PID as deterministic tie-breaker.
- Kernel threads (no `VmRSS`, empty `cmdline`) and defunct processes are counted in
  `skipped`, never rendered as 0-memory applications.
- Fallbacks before giving up: name from `comm`, memory from `statm` resident pages
  (labelled derived; 4 KiB page assumption is the only one made).
- Honest failure states: `available:false` + reason for non-Linux platforms and an
  unreadable proc root; `permissionLimited:true` when another user's process is unreadable
  (that process is omitted, not zeroed); bounded de-duplicated `errors[]`; explicit
  `truncated` flag; `system` headroom always returned when measurable.
- Only display data is returned: PID, name, uid, own/relay booleans, RSS bytes. No paths,
  command lines or environment.

IPC: `electron/main.mjs` — new `processes` action (`z.object({}).strict()`, no input)
returning `collectProcesses()`. Separate from the frequently-sent `snapshot`, so idle
sessions do not pay for it. `electron/preload.cjs` needed no change (generic channel);
main-frame sender validation still applies. **Operator's `--reserve-gib` plumbing in
`service.mjs` / `localai_bridge.py` is untouched.**

Renderer (new, mine): `src/features/compute/processMemoryLogic.ts` (pure) +
`src/features/compute/ProcessMemory.tsx` (component), wired into the existing Compute page
as its last section:
- Horizontal bar per process with name, PID, and a text MiB/GiB value (usable without
  colour, pointer, or the bar itself; extra screen-reader text per row).
- Total / used / available system memory beside the chart, metric label, own-vs-other-user
  RSS split, update time, "Stale" tag, and "N started, M exited" between samples.
- Name/PID search (digits match PID **prefix** plus names, so "9" does not match the world),
  sort selector (memory default, name, PID), manual Refresh.
- Auto-refresh every 5 s only while the Compute page is mounted and the window is visible;
  stops on hide/unmount. A failed poll shows the reason, keeps the last sample and pauses
  auto-refresh until manual Refresh, so a broken collector cannot toast every tick
  (App's `call()` toasts and returns `undefined`).
- Unavailable → error notice "not measured" (never an empty list); permission-limited →
  warning that processes are omitted, not counted as zero; truncation → explicit note.
- Note stating RSS includes shared pages, so bar totals exceed memory in use, and that this
  measured data is separate from scheduler/model reservation estimates.
- Styles appended under a labelled section in `src/styles.css` using existing theme
  variables, plus light-theme and `prefers-reduced-motion` handling.

`src/types.ts`: additive `ProcessSample` / `ProcessTelemetry` after `Snapshot`.
`src/App.tsx`: two lines from me — the import and `<ProcessMemory call={call} />` as the last
child of `Compute`. B has since applied its own status-UI integration on top; both coexist
(import at line 66, panel at line 2287) and the combined file type-checks and tests green.

## Verification (no models, no inference, no Electron, no dist build)
- `node --test tests/process_telemetry.test.mjs` → **15 pass**: fixture proc tree listing and
  descending order; duplicate names/distinct PIDs; kernel-thread/zombie skipping; `statm`
  and `comm` fallbacks; exit-mid-scan (ENOENT) skipped without error; EACCES → permission
  limited; unreadable root; non-Linux → unavailable with system totals; truncation;
  helper unit checks (formatting, bar scale, search, sorting, summary, staleness,
  start/exit diff, notice wording); **two real-component static renders** (esbuild bundle +
  `react-dom/server`, shared React instance) asserting one row per process with
  name/PID/text memory, system totals, shared-page note, and the unavailable /
  permission-limited / IPC-failure states.
- `npx tsc --noEmit` → clean. `node --check` on both modified `.mjs` files → clean.
  Prettier clean on every file I touched.
- Full backend suite: **86/86 pass** (`node --test tests/*.test.mjs`: artifacts, core,
  delegation, process telemetry, session status, status parity, skills, tasks). Mid-run I
  also saw a transient parse failure in B's `tests/status_parity.test.mjs` while it was
  being written; B fixed it and the final run is green.
- Live collector smoke on this machine (reads `/proc` only): 153 processes listed,
  419 kernel threads/defunct skipped, 0 errors, ~9–18 ms per sample.

## Known limits (not hidden)
- Linux-only measurement. Other platforms show an explicit unavailable notice instead of
  estimates. No elevation is attempted.
- Rows are capped at 1000 rendered per sample for DOM cost, with a visible "showing the
  largest N of M" note; search still filters the complete measured list.
- Collector runs on the Electron main process (~10–18 ms per sample here); a worker thread
  would be the next step if sample cost grows on process-heavy hosts.
- No per-session → PID attribution (agreed with C); measured process RSS and provider token
  accounting stay separate in the UI.
- Not verified in packaged Electron, at 200% zoom, or with a screen reader: the README bars
  concurrent Electron acceptance, so that check is left to the reviewer. Visual layout was
  checked only by static render + existing theme variables.
- Requires an app rebuild for the new IPC action to exist in the packaged executable;
  nothing was rebuilt or restarted.

## Coordination
`src/App.tsx`, `src/types.ts`, `src/styles.css`, `electron/main.mjs` and my test locks are
released. B's `B-integration.patch` applies cleanly to my working tree
(`git apply --check`); I did not apply it. Answers and interface notes are in
`A.inbox.md`, `B.inbox.md`, `C.inbox.md`; my locks were the only ones I removed.
