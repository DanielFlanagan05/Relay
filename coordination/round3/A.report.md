# Agent A report — Session context usage bar (round 3)

## Summary

Each session now renders a `<context used> / <context available> tokens` line at
the bottom-right, directly above the composer text box, with an explicit
compaction status slot. The derivation is a pure, tested module; all
shared-file edits are small and were done under the advisory locks (all
released).

## Changes

### New files (no locks needed)
- **`src/features/context/contextUsageLogic.ts`** — pure logic:
  - **Used** = the most recent `usage.contextInput` (per-request input,
    cached input included — it is built with `inclusiveInput()` in
    `electron/protocol.mjs`). Never `turnUsage` / cumulative billing totals;
    turn-scope usage records deliberately lack `contextInput` and are ignored
    as occupancy.
  - **Estimated** (only when no per-request count exists at all): ~4 chars/token
    over the visible transcript — content, thinking, tool records, and the
    instruction snapshot frozen for the *latest* user turn only. Labelled `~`
    with a tooltip stating it excludes the system prompt and likely under-counts.
  - **Unavailable**: fresh/empty sessions show `—`, never `0`; unknown model
    capacity shows `—` too.
  - **Stale**: a measured value is stale when a newer user message is not part
    of the measured request (visually dimmed/italic, explained in aria-label
    and tooltip). The streaming assistant message reporting its own usage
    clears staleness mid-turn.
  - Formatting (`24,000 / 128,000 tokens`, `~…` for estimates), aria text, meter
    percentage (clamped 0–100), and compaction display helpers.
- **`src/features/context/ContextUsage.tsx`** — presentational component;
  derives everything from the `session`/`model` props it is given, so session
  switching can never show another session's values (each render recomputes
  from the new session's own messages; covered by a test).
- **`tests/context_usage.test.mjs`** — 11 mock-fixture tests (same esbuild
  transpile-to-data-URL pattern as `session_status.test.mjs`): measured,
  cached-input/turn-total rejection, estimated (incl. tools/thinking/latest
  snapshot only), unavailable (never zero), stale, fresh-during-running-turn,
  model/context-limit switch, session switching, compaction
  running/done-with-time/failed/unknown, meter clamping, and static wiring
  checks (component mounted above composer, live region stays mounted,
  `Session.compaction` type exists).

### Shared files (locks taken → released)
- **`src/types.ts`** — additive optional `Session.compaction?:
  { status: "running" | "done" | "failed"; at: string }` with a comment
  documenting the event-only contract.
- **`src/App.tsx`** — one import plus one line: `<ContextUsage session={session}
  model={model} />` inside `Conversation`, immediately above the `.composer`
  box. Always rendered (idle, queued, running, archived).
- **`src/styles.css`** — new `.context-usage-row` block (own flex row above the
  composer, right-aligned, `flex-wrap` so it cannot overlap composer controls
  at narrow widths or 200% zoom), tabular-nums text, small meter, compaction
  chips (running/done/failed), light-theme overrides. No existing rules
  modified.

## Compaction detection — honestly unavailable

I searched `electron/protocol.mjs` for every integrated harness (pi, codex,
claude, opencode, hermes): **none emit a verifiable compaction event** in the
streams Relay parses, so nothing sets `Session.compaction` at runtime. Per the
assignment, the field, the UI ("Compacting context…", "Context compacted" with
last time in the `title`, "Compaction failed"), and the persistent
`role="status"` / `aria-live="polite"` slot are fully wired — when a future
protocol event appears, setting `session.compaction` from it is the only
change needed. A token-count decrease alone is never treated as compaction
(documented in `types.ts`, `contextUsageLogic.ts`, and here). No changes were
made to `electron/protocol.mjs` or `electron/service.mjs`.

## Checks

| Check | Result |
|---|---|
| `node --test tests/context_usage.test.mjs` | **pass** (11/11) |
| `npx tsc --noEmit` | **pass** (exit 0) |
| `node --test tests/session_status.test.mjs tests/usage_accounting.test.mjs tests/status_parity.test.mjs` (regression) | **pass** (27/27) |
| Full `node --test tests/*.test.mjs` | **not run** (round rules: shared checkout with Agent B; ran the neighbouring suites instead) |
| `npm run build` / Electron acceptance / app restart | **not run** (prohibited by round rules) |
| GUI/visual check | **not run** — needs the reviewer (steps below) |

## Remaining work / known limitations

1. **Compaction events**: wiring only until a harness emits a real event; the
   reviewer cannot trigger a live compaction today. Detection remains
   *unavailable*, not approximated.
2. **Estimates** exclude the harness system prompt and tool schemas, so they
   under-count; the tooltip says so explicitly.
3. **Mid-turn freshness** depends on the harness reporting usage per request
   (pi does at each `message_end`; turn-scope harnesses fall back to the
   estimate, which recomputes from live transcript text).
4. Model-switch staleness of a *measured* count cannot be detected (messages
   carry no model tag); the capacity number updates correctly on switch.
5. The usage row is intentionally absent from the 1100px layout rules — it
   wraps on its own row, but this should be eyeballed at 200% zoom.

## GUI validation steps (reviewer; no model loading required)

1. Open any session. Confirm a small right-aligned line just above the message
   box, e.g. `— / 128,000 tokens` on a fresh session and `~3,456 / 128,000
   tokens` (tilde = estimated) or a plain measured count for Pi sessions after
   a turn.
2. Hover the line: the tooltip explains measured vs estimated vs stale.
3. Send a short message on a non-Pi session and watch the value stay visible
   while queued/running; on a Pi session the count updates between requests.
4. Switch to another session mid-turn: the numbers must belong to the visible
   session only (a fresh session must show `—`, never the previous session's).
5. Session details panel and the new line must agree for Pi sessions (both read
   the same `usage.contextInput`).
6. Compaction fixture: with devtools, set a session's `compaction` field via a
   snapshot patch (or a saved workspace fixture) to `{status:"running"}` →
   "Compacting context…" chip; `{status:"done", at:"…"}` → "Context compacted"
   with the time in the hover title; `{status:"failed", …}` → failure chip, not
   success. A screen reader should announce changes through the persistent
   status region.
7. Resize the window narrow and set 200% OS zoom: the line must wrap above the
   composer without covering the model name, slots, or send button.
