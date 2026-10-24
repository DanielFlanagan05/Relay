# Agent C report — round2

Timestamp: 2026-10-23T02:10Z. Scope: accurate per-turn usage/rate accounting
(reasoning/tool-only activity, cache-aware reporting where actually available)
+ evidence-based bundled skill wording. All locks released.

## What changed

### Backend accounting (`electron/usage.mjs`, new)
Pure helpers, single source of truth for honesty rules:
- `normalizeUsage`: keeps only finite non-negative numbers; `cacheRead`,
  `cacheWrite`, `reasoning` present only when the route reported them.
  An event with no usable numbers yields `null` — no more silent `{0,0}`.
- `addUsage`: cumulative per-turn totals across a turn's provider requests.
- `estimateOutputTokens`: one labelled character estimate (includes reasoning
  text, which is generated output).
- `finalizeRate`: measured provider output over active (non-queued) seconds
  wins; otherwise labelled estimate; otherwise **no rate** — a tool-only turn
  with no reported usage never shows a text-generation rate.

### Provider capture
- `electron/protocol.mjs`: pi `usage.cacheRead/cacheWrite`; codex
  `cached_input_tokens`/`reasoning_output_tokens`; claude
  `cache_read_input_tokens`/`cache_creation_input_tokens`; opencode
  `tokens.cache.read/write`. Absent fields stay absent (verified). hermes
  passthrough unchanged (no invented keys).
- `electron/adapters.mjs` (Direct): OpenAI-compatible
  `prompt_tokens_details.cached_tokens` → `cacheRead` and
  `completion_tokens_details.reasoning_tokens` → `reasoning`.

### Turn lifecycle (`electron/service.mjs`, `execute()` regions only)
- `answer.usage` = last provider request (context occupancy semantics kept);
  `answer.turnUsage` + `answer.requests` = cumulative measured totals across
  delegation rounds — previously every usage event overwrote the turn's numbers.
- Elapsed time now accumulates across parked-continuation segments
  (`baseMs` carried on `answer.elapsedMs`, folded in on park); previously a
  parked turn reset its duration to the resumed segment only. Queue wait is
  excluded from the final rate denominator.
- On completion the rate is finalized: measured → `estimatedRate:false`;
  no usage → labelled estimate including thinking text; tool-only with no
  usage → `tokensPerSecond=0` (UI hides it) with duration preserved.

### Renderer (additive, after A's 10:35 release and B's declared release)
- `src/types.ts`: optional `Message.turnUsage`, `Message.requests`, and optional
  `cacheRead/cacheWrite/reasoning` inside the existing optional `usage`.
  A's `ProcessSample/ProcessTelemetry` and B's `delegation/Snapshot` additions untouched.
- `src/App.tsx`: message-stats shows turn-cumulative output tokens with
  `· N req` for multi-request turns; SessionInspector adds "Of which cached",
  "Turn total · N req (in/out)", and "Reasoning output" rows — each rendered
  only when the measured value exists; "—" still means unavailable.
  Did not enter Compute, status, or delegation UI regions.

### Bundled skills (evidence-based wording)
`skills/concise/SKILL.md`, `skills/review/SKILL.md`, `skills/subagents/SKILL.md`
now carry the plan's suggested content: concise adds "unnecessary headings" and
"never omit necessary information just to be brief"; review aligns to "no
actionable findings remain / material validation gaps"; subagents adds parallel
execution value, "avoid overlapping edits" and "Cancel unnecessary children" —
direct responses to AGENT_REVIEW.md findings (duplicate/overlapping edit
problems, slot-holding parents, and unreplayed work). IDs, descriptions,
frontmatter and the `requires:["delegation"]` gate are unchanged; store sync
still never overwrites user-edited copies (`store.mjs` migration +
`normalizeSkill` origin logic, re-read before relying on this).

## Verification (no models loaded, mocks only)
- `node --test tests/usage_accounting.test.mjs`: 9/9 — helper rules, per-harness
  capture including *absent-telemetry-stays-absent*, Direct SSE cached/reasoning
  tokens via fake HTTP server, end-to-end multi-request turn (cumulative totals,
  last-request context, measured rate == turnUsage.output / active seconds),
  estimated-rate path, tool-only no-rate rule, skill wording + gating.
- Full suite `node --test tests/*.test.mjs`: **95/95 pass** (core 55, A+B and
  prior tests unaffected).
- `node scripts/ux-smoke.mjs`: pass (fixture renderer checks).
- `python3 tests/bridge_test.py`: pass — operator's `--reserve-gib` plumbing
  verified present and untouched (store default 8 GiB + validated schema found).
- `npx tsc --noEmit`: clean. `prettier --check`: clean on files I touched
  (App.tsx reformat limited to my own lines, verified by diff).

## Coordination
- No interrupted edits found on resume: no C status/locks/report existed and
  OBSERVATION.json showed C at 0 requests; I started clean and preserved A's,
  B's and the operator's working-tree changes throughout (re-read files before
  every shared edit).
- Replied to A (RSS/no-attribution OK) and B (usage-field semantics, canonical
  delegation wording) in the inboxes; requested and used A's released
  App.tsx/types.ts window; left B's released claim dirs in place.
- Reviewed B's `sessionStatus.ts` at their request: it explicitly excludes
  usage/rate/GiB fields; no contradiction found.

## Remaining work (not in this slice)
- Compaction status and the `<used> / <available>` composer meter (plan §"Session
  context usage and compaction") need harness compaction events that no current
  adapter emits; needs a protocol decision before UI claims — left unclaimed.
- Live-provider qualification of the new cache/reasoning field mappings
  (codex/pi/opencode/claude field names per installed version) — authorized
  only via separate live checks.
- Per-request cache display for *older* turns (only the last assistant message
  carries usage in the inspector today).
- Electron acceptance of the new inspector rows — reviewer-owned per README
  (I did not run shared dist builds or Electron acceptance).
