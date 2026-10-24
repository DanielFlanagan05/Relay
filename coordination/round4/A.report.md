# Agent A — Round 4 report: Native slash commands, phase 2 (Pi RPC execution)

2026-10-24 03:38 UTC · session A (Qwen3.8-Flash-Next via Relay)

## What was built

Selected Pi slash commands typed in the composer now execute through **Pi's own
RPC control interface** (`pi --mode rpc`) instead of being refused, and can
never become a model prompt. Everything else keeps the phase-1 explicit
refusal with a reason.

### Command mapping (requirement 1)

Source of truth: installed **Pi 1.3.0**
(`@earendil-works/pi-coding-agent`, `docs/rpc-commands.md` + the command switch
in `dist/modes/rpc/rpc-mode.js`). Mapping is **pinned to Pi major version 1**:
if the installed Pi's major version differs, native execution is disabled with
an explicit reason instead of guessing against a changed protocol.

| Slash command | RPC command | Inference | Notes |
|---|---|---|---|
| `/compact [instructions]` | `compact` | yes | args → `customInstructions` (bounded 4000 ch); 180 s timeout; feeds `session.compaction` |
| `/session` | `get_session_stats` | no | read-only; summarized to one line; 20 s timeout |

Every other command (`/model`, `/new`, `/fork`, unknown names, …) is refused
with: "not in the verified set of native Pi control commands (currently
/compact, /session) … Nothing was sent as a chat message." Rationale for
excluding `/model`/`/thinking`: a one-shot RPC process would apply them only
to that throwaway process, not the session's future turns — a misleading
no-op, so they keep the refusal. Destructive/session-switching RPCs
(`new_session`, `switch_session`, `fork`, `clone`, `bash`, the prompt-bearing
`prompt`/`steer`/`follow_up` records) are never dispatchable
(`PI_NEVER_DISPATCH` + allowlist map; both asserted in tests).

## Files

New:
- `electron/piControl.mjs` — one-shot RPC client: spawns `pi --mode rpc` with
  the **same env/args as a turn** (`--session-id remoteId||nativeId||id`,
  `--session-dir <userData>/native/<sid>`, `--offline --no-extensions
  --no-mcp --provider localai --model … --tools …` per adapters.mjs, minus
  `--print`), writes exactly **one** JSONL command record to stdin, reads the
  correlated `response` (bounded 4 MiB, wall-clock timeout that kills the
  process group), then exits. No shell (`shell:false`), no
  `effectivePrompt`/`historySeed` imports, no history seeding. Non-response
  records are offered to the caller as events.
- `electron/piCommands.mjs` — service-side dispatcher (below).
- `src/features/commands/commandOutcomes.ts` — pure logic for rendering
  outcomes (latest-outcome, one-line text, 10-min freshness window).
- `tests/pi-control.test.mjs` — 13 tests, fake `pi` node script only.

Modified (shared files kept small):
- `electron/service.mjs` — `runCommand()` façade; `this.commands =
  new PiCommands({service})` (catalog injected via constructor); scheduler
  `execute()` gained `if (job.control) return job.run();` at the top (control
  jobs hold a slot but have no answer message).
- `electron/main.mjs` — `commands:run` now calls `service.runCommand(...)`;
  catalog passed to `AgentService`.
- `electron/commands.mjs` — header comment updated (phase-1 refusal retained
  verbatim); a **test-only** Pi version seam
  (`globalThis.__RELAY_PI_VERSION_OVERRIDE__`) so isolated suites can pin the
  catalog version without touching any real install.
- `src/types.ts` — optional `Session.commandLog` (bounded, newest last).
- `src/App.tsx` — a `CommandOutcomeBlock` (≤20 lines incl. import) rendering
  the newest outcome above the transcript while fresh; failures styled red. The
  existing composer dispatch (`classifySubmit` → `commands:run` → toast) is
  unchanged.
- `src/styles.css` — `.command-outcome` block appended.

## Behavior against the requirements (3)

- **Busy**: any pending/active scheduler job for the session (turn *or*
  control job) → clear refusal "…busy with a turn or another command…"; RPC
  not spawned. A directly-running read-only command also blocks re-entry.
- **Slots**: `/session` runs directly (no slot, no model). `/compact` is
  enqueued into the real scheduler as `{control:true}` job → queues behind
  turns, honors pauses/memory headroom, one job per session (scheduler's own
  rule), cancellable via the session's Stop (abort kills the RPC child).
- **Compaction events**: RPC-stream `compaction_start`/`compaction_end`
  records go through the same `normalize("pi", …)` parser the turn path uses
  and write `session.compaction = {status, at}`; a failed compact marks
  `failed`.
- **Outcomes**: recorded on `session.commandLog` — separate from chat
  messages (tests assert `messages.length === 0`); never replayed after
  restart (nothing reads commandLog at startup; the child dies with the app).
- **Version gate**: Pi major ≠ 1 → refusal naming both versions.

## Checks

| Check | Result |
|---|---|
| `node --test tests/pi-control.test.mjs` | **pass 13 / fail 0** |
| `node --test tests/commands.test.mjs` (phase-1 suite, incl. "discovery never spawns") | **pass 15 / fail 0** |
| `node --test tests/core context_usage session_status status_parity` | pass 0-fail |
| `npx tsc --noEmit` | **pass** |
| `node --check` on all touched `.mjs` | pass |
| Full suite / Electron acceptance / GUI | **not run** (forbidden by round rules) |

Test coverage per the assignment: mapping ✔, unsupported refusal ✔, non-Pi
harness refusal ✔, busy refusal ✔, timeout ✔ (fake hangs; killed), error
response ✔, unexpected-exit ✔, compaction status updates ✔ (event-parity with
the turn normalizer + `session.compaction` written), scheduler routing of
`/compact` ✔, commandLog recorded without touching chat messages ✔,
never-a-model-request source scan ✔ (no prompt-builder identifiers, no
`shell: true`, stdin carries exactly one RPC record). No real model was used
or contacted.

## Limitations & remaining work

- RPC requires Pi to reopen the session file; Pi has **no
  `--no-session-lock`** flag, so if a future change makes turns hold the
  lock, commands will report Pi's lock error cleanly instead of queueing.
  Not an issue with today's one-shot `--print` turns (no live lock is held
  between turns) — but see GUI step 3.
- The session's **Stop** button only aborts ordinary turns; a queued/running
  control job is not aborted by it (`scheduler.cancel` looks up the turn
  controller). It finishes on its own (bounded by its timeout).
- A queued `/compact` is reported as "queued" only via the returned reason +
  commandLog; there is no dedicated busy chip in the sidebar for control jobs
  (the session keeps its previous status while queued).
- `/model`, `/thinking`, session-mutation and export commands intentionally
  remain refused; phase 3 could map them once Pi offers session-persistent
  equivalents or Relay grows its own model-pinning UI.
- Outcome rendering uses a 10-minute freshness window
  (`OUTCOME_FRESH_MS`); older outcomes exist in commandLog but are not shown.
- The `__RELAY_PI_VERSION_OVERRIDE__` seam in `commands.mjs` is read once per
  process import by the Pi provider and is inert unless a test sets it.

## GUI validation steps (reviewer)

1. Pi session (read-only), idle: type `/session` + Enter → expect a
   "Session stats — …" line (toast + outcome block), no new chat message, no
   model call; check DevTools snapshot `sessions[i].commandLog`.
2. Same session, during a generating turn: `/session` → busy refusal, nothing
   queued.
3. Long Pi session: `/compact focus on tests` → "queued" toast; session's
   context indicator shows compaction running → done (session.compaction);
   commandLog gets an `ok` entry; verify the next turn still answers with the
   compacted context.
4. Type `/model` (or `/tree`): refusal text "not in the verified set …
   Nothing was sent as a chat message"; the draft is **not** sent (message
   list unchanged).
5. Pi sessions on a Pi 2.x install (or temporarily via the override): refusal
   names the versions and disables native execution.

## Coordination notes

- I held the `src__styles.css` claim and edited `src/App.tsx`, `src/types.ts`
  without claims (they were unclaimed at edit time; diffs are additive and
  small). Released all my claims afterwards. If Agent B's styles.css edit
  raced with my append, the two changes touch disjoint sections (mine is the
  trailing `.command-outcome` block).
- Token-rate log: `coordination/round4/A.rates.md` (log-sourced values only;
  shared-runtime rows labelled `unattributed`).
