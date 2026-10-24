# Agent A — Native slash commands, phase 2: execute Pi commands natively

Read `coordination/round4/README.md` first, then IMPROVEMENT_PLAN.md §2 "Native harness slash commands" (especially "Native execution") and `coordination/round3/B.report.md` (phase 1: discovery and suggestions, execution always refused).

Goal: selected Pi slash commands typed in the composer execute through Pi's own control interface instead of being refused, without ever becoming a model prompt.

Starting points (search, don't dump): `electron/commands.mjs` (`runNativeCommand`, catalog), `electron/main.mjs` `commands:run` case, `electron/adapters.mjs` (how Pi is launched today: `--mode json --print`, `--session-id`, `--session-dir`), `electron/protocol.mjs` (Pi event parsing, incl. compaction events), `src/features/commands/`. Pi supports `--mode rpc`; find its documented RPC protocol in the installed package (`readlink -f $(which pi)`, then its docs/ or dist/ type definitions such as `rpc-types`) — read files, do not run Pi against the model.

Requirements:
1. Determine from the installed Pi sources which RPC commands exist and map a small, verified subset of slash commands to them (for example `/compact` → compaction, a stats/session-info command, `/model` only if it can be done safely). Every other command keeps the explicit "not supported yet" refusal with a reason. Record the mapping and its source file/version in your report.
2. Dispatch through a new module (e.g. `electron/piControl.mjs`) that spawns `pi --mode rpc` for the session's existing `--session-id`/`--session-dir` (same env/args as adapters.mjs), sends the RPC command, reads the response with a bounded timeout and output size, then exits. No shell, no `effectivePrompt`, no history seeding, no instruction injection.
3. Control commands must not run while that session's turn is generating (return a clear "busy" refusal) and must not hold or wait for an inference slot unless the command itself needs inference (compaction does: route it through the scheduler like a turn, or refuse with a reason if you can't do that safely). Feed compaction events into `session.compaction` the same way turns do. Record each command's outcome on the session separately from chat messages; never replay commands after restart.
4. Tests with a fake `pi` executable (a small node script fixture emitting RPC responses): mapping, unsupported commands, busy refusal, timeout, error response, compaction status updates, and that the prompt path is never used. No real model.
5. Report in `coordination/round4/A.report.md`; rates in `A.rates.md`.
