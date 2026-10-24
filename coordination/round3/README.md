# Round 3 — two Qwen3.8-Flash-Next sessions (2026-10-23)

The user authorized these two Relay coding sessions only. Work in `/home/danfl/dev/Relay`. Read only the plan sections named in your assignment plus the code you need (search before reading; App.tsx is ~3,100 lines). Existing uncommitted changes are reviewed work: do not revert them.

- **A — Session context usage bar** (IMPROVEMENT_PLAN.md §2, "Session context usage and compaction").
- **B — Native harness slash commands, phase 1** (IMPROVEMENT_PLAN.md §2, "Native harness slash commands").

## Shared rules
- Both sessions share this checkout. `src/App.tsx`, `src/types.ts`, `src/styles.css`, `electron/main.mjs`, and `preload` are shared. Before editing a shared file, take an advisory lock: `mkdir coordination/round3/claims/<path-with-/-replaced-by-__>` and write owner+intent in a file inside it. Release only your own lock after the edit. If claimed, work elsewhere and retry later. (Stale round2 claims are not yours to use; ignore `coordination/round2/claims`.)
- Put new logic in new files under `src/features/<feature>/` and `electron/<feature>.mjs` so shared-file edits stay small.
- No package installs, package.json/lock changes, global formatting, `npm run build`/dist builds, packaging, or Electron acceptance runs. `npx tsc --noEmit` and `node --test tests/<your-file>.test.mjs` are fine.
- No model loading, inference tests, benchmarks, or runtime/app restarts. Never stop or restart Relay or the model runtime hosting you. Do not create other agents.
- Use mocks/fixtures for tests. Don't invent metrics; label estimates and unavailable values.
- Finish with `coordination/round3/<A|B>.report.md`: changes, files, checks run (pass/fail/not run), remaining work, and GUI validation steps for the reviewer.

## Token-rate log (required)
Keep `coordination/round3/<A|B>.rates.md` as a markdown table you append to after each major phase (at least: after exploration, after implementation, at completion):

| time (UTC) | phase | prompt tokens | prefill tok/s | generated tokens | decode tok/s | source |

Get prefill and decode rates from the local runtime's own per-request timing (e.g. the LocalAi/llama.cpp/Gufo server log lines such as `prompt eval ... tokens per second` / `eval ... tokens per second`, or the server's `timings` field). Find the log path via `localai` CLI help/status, `~/.config/localai`, or the Relay app-data `runtime.log` (`~/.config/Relay/`). Read only the tail of logs. Record the exact source (file + line excerpt). If a value cannot be found, write `unavailable` and say why — do not estimate decode speed from wall-clock time and call it measured. Do not send extra requests to the model to measure speed.
