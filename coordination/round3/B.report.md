# Agent B — Native harness slash commands, phase 1 (2026-10-23)

## What was built

1. **Local discovery + cache** — `electron/commands.mjs` (new)
   - A catalog provider per harness (`CATALOG_PROVIDERS`): Pi and Hermes have
     real installed-source catalogs (below); OpenCode, Codex, and Claude Code
     are reported `unavailable` with per-harness reasons. No hand-written
     universal list exists anywhere in the code path.
   - Discovery is **pure local file reads**: no subprocess is spawned at all
     (so there is nothing to time-bound), no model call, no network. Every
     read is capped at 4 MiB; ancestor searches are depth-bounded (≤6).
     A guard test fails if `child_process`, `spawn(`, `execFile`, `fetch(`,
     `node:http(s)`, or `WebSocket` ever appear in the module.
   - Records per command: `name`, `aliases`, `description`, `args`, `category`
     (Hermes), `source`; per catalog: `harness`, `version`, `status`
     (`complete | partial | unavailable | not-installed | not-applicable`),
     `reason`, `fingerprint`, `discoveredAt`.
   - Cache persists to `<userData>/command-catalog.json`. Invalidation uses a
     fingerprint of **installed version + registry/binary mtime + size**, so a
     harness update that adds/removes commands (or even rewrites the registry
     with the same version) re-discovers on the next read. Manual refresh via
     `commands:refresh`. In-memory memo means no scanning per keystroke — the
     per-call cost is a version read plus one `stat`.
   - Empty/unparseable registry → `unavailable` with "format may have changed"
     instead of guessing.

2. **IPC** — `electron/main.mjs` (additive; claim taken and released)
   - zod schemas `commandsList {sessionId: uuid}`, `commandsRefresh {harness:
     enum pi|opencode|hermes|codex|claude}`, `commandsRun {sessionId, name:
     regex `[a-z][\w-]{0,49}`, args ≤4000}`, all `.strict()`. Namespaced
     `commands:list` / `commands:refresh` / `commands:run`, completely separate
     from `send`; the handlers never touch `service.send`, `effectivePrompt`,
     the scheduler, or a shell.
   - `preload.cjs` unchanged (its generic `call(name, input)` bridge already
     carries the new actions; validated in main).

3. **Composer suggestions** — `src/features/commands/` (new) + minimal hook-in
   - `commandLogic.ts` (pure): open condition (draft is a single line starting
     with exactly one `/`; `//` is the literal-slash escape; multi-line,
     mid-text, and post-space argument entry never open the listbox — code
     blocks/quotes/prose stay ordinary text), prefix filtering over
     names+aliases (name matches ranked first, cap 12, registry order
     preserved), keyboard model (ArrowUp/Down wrap, Enter/Tab select only when
     an option exists, Escape dismisses, IME-composition always ignored),
     insertion (`/name ` with trailing space for arguments), and
     `classifySubmit`: on explicit submit, a draft whose first token is a
     **discovered** command (name or alias) dispatches `commands:run`; `//foo`
     sends literal `/foo`; unknown `/word` and everything else remain plain
     message text. A command is therefore never converted into a chat prompt.
   - `SlashSuggest.tsx`: accessible listbox (`role="listbox"`, option ids,
     `aria-activedescendant`, textarea gets `role="combobox" aria-expanded
     aria-controls aria-autocomplete`), header showing harness/version +
     discovery honesty line, a **Refresh** button, per-command aliases,
     argument syntax, description, and a tooltip stating native execution is
     pending (never silent). Catalog statuses are surfaced honestly
     (`unavailable` harnesses show the reason and a note that text sends as an
     ordinary message). Direct chat never fetches or shows native commands.
   - Relay actions (Ctrl+K palette) and skills (instruction selector) are
     untouched and do not appear in the listbox.
   - App.tsx hook-in kept deliberately small (claim taken and released):
     import, one `useSlashCommands(...)` call in `Conversation`, `{slash.list}`
     inside the composer box, `if (slash.onKeyDown(e)) return;` before the
     existing Enter-to-send, and a submit-classification block at the top of
     `send()` (draft is preserved after a command dispatch; nothing is cleared
     or sent). styles.css: appended a self-contained `.slash-suggest*` section
     plus `position: relative` on `.composer`.

4. **Tests** — `tests/commands.test.mjs` (new, 15 tests, all pass)
   Fake installed-harness fixtures in temp dirs (XDG_DATA_HOME overridden so a
   real machine install can't leak in): Pi registry parse (incl. template-
   literal descriptions), Hermes `COMMAND_REGISTRY` parse (aliases, args_hint,
   apostrophes), cache hit/reuse + update adding/removing commands invalidates,
   persisted cache survives "restart", force refresh, missing registry,
   format-changed/unparseable registry, not-installed, binary-only harnesses
   unavailable, direct chat not-applicable, `run()` refuses execution while
   asserting `send` is never called + alias resolution + unknown-name
   rejection, and the no-spawn/no-network source guard. Pure-logic tests cover
   open condition, filtering, keyboard model incl. IME, insertion, and submit
   classification incl. `//` literal.

## Per-harness local-catalog findings (installed on this machine)

| Harness | Installed as | Local catalog source found | Status |
|---|---|---|---|
| Pi 1.3.0 (`~/.local/share/localai/apps/node/.../@earendil-works/pi-coding-agent`) | npm package | `dist/core/slash-commands.js` → `BUILTIN_SLASH_COMMANDS` (24 entries, name/description/argumentHint) — the same registry the TUI renders. Version from `package.json`. | **complete** (live-verified) |
| Hermes (`~/.local/share/localai/apps/hermes`) | Python venv/source tree | `hermes_cli/commands.py` → `COMMAND_REGISTRY` `CommandDef(...)` entries; file documents that CLI help, gateway dispatch, and autocomplete all derive from it. 104 entries parsed with aliases and `args_hint`. Version from `hermes_agent.egg-info/PKG-INFO` (reported `0.0.0`). | **complete** (live-verified) |
| OpenCode (single 186 MB binary in `apps/opencode`) | binary | None. No bundled manifest; `~/.config/opencode/command` does not exist on this machine. | unavailable |
| Codex 0.163.0 (`~/.codex/packages/standalone/...`) | musl standalone binary | None. Package ships only `bin/codex`, `codex-path/rg`, and voice/bwrap resources. A bounded strings probe found no slash-command table; binary scraping is not a labeled catalog source. | unavailable |
| Claude Code 2.1.309 (`~/.local/share/claude/versions/…`) | single 293 MB native binary | None bundled. Custom-command directories (`~/.claude/commands`) don't exist here and would be a phase-2 source (they cover custom, not built-in, commands). | unavailable |

## Native execution — why phase 1 returns an explicit refusal

Verified in `electron/adapters.mjs::runCLI`: every harness turn is a fresh
headless subprocess and `child.stdin.end(spec.input)` closes stdin right after
the prompt; Relay holds no persistent process, and none of the installed
harnesses exposes a verified local command/control interface reachable from
that mode (`codex exec -` / `claude -p` / `pi --print` would forward `/model`
to the **model as prompt text** — exactly the failure mode the plan forbids).
`runNativeCommand` therefore: rejects direct chat, rejects unknown commands
against the discovered catalog (with version), and otherwise returns
`{ executed: false, command, args, reason: "...native execution is not
supported for this harness/mode yet..." }`. The IPC action does not call
`send`, the scheduler, spawn, or fetch; tests assert this.

## Files

- New: `electron/commands.mjs`, `src/features/commands/commandLogic.ts`,
  `src/features/commands/SlashSuggest.tsx`, `tests/commands.test.mjs`,
  `coordination/round3/B.rates.md`, this report.
- Edited (shared, with claims taken/released): `electron/main.mjs`
  (3 schemas + 3 additive cases + catalog init), `src/App.tsx` (4 small
  hook-in spots), `src/styles.css` (appended section only).
- `preload.cjs`, `src/types.ts`: **not** modified (generic bridge; types live
  in the feature module).

## Checks

| Check | Result |
|---|---|
| `node --test tests/commands.test.mjs` | **pass** (15/15) |
| `node --test "tests/*.test.mjs"` (whole mjs suite, incl. Agent A's) | **pass** (128/128) |
| `npx tsc --noEmit` | **pass** |
| `node --check electron/main.mjs`, `electron/commands.mjs` | **pass** |
| Live discovery against real installs (script, read-only) | **pass** (pi 24, hermes 104, others unavailable) |
| GUI/Electron acceptance run | **not run** (prohibited this round) |
| `tests/bridge_test.py` | not run (untouched by these changes) |

## Remaining work / limitations (honest list)

- **Execution is uniformly refused** — no harness/mode has a verified native
  control channel yet (phase 2: persistent protocol/SDK bridge, e.g. Pi's
  rpc-entry or JSON-RPC sessions; then `/exit`/`/model` semantics).
- Commands submitted while a turn is in flight fall under the composer's
  existing busy guard and are not dispatched (control commands bypassing the
  inference slot is phase-2 behavior, gated on real execution anyway).
- Hermes version reads `0.0.0` from its egg-info (upstream packaging); shown
  as-is, not suppressed.
- Pi custom prompts/extensions are not enumerated (built-in registry only).
- Suggestion list caps at 12 with no scroll-into-view beyond the browser's
  native behavior inside the max-height box.
- The rates log records the two freshest runtime-reported request timings; a
  request's per-token rates only appear in the server log after it completes,
  so a session cannot log its *own* current request rates (noted in the log).

## GUI validation steps for the reviewer

1. Start a **Pi** session → type `/` in the composer: a listbox appears above
   the composer with Pi 1.3.0's 24 commands, header "Pi 1.3.0 · discovered
   locally". Type `mo` → filters to `/model` (args `<provider/model>` shown).
2. ArrowDown/ArrowUp move the highlight (wrapping); Enter or Tab inserts
   `/model ` and leaves the caret for arguments; Escape dismisses (typing
   again reopens once the draft no longer matches).
3. With `/model` in the draft press Enter: **nothing is sent** — a notification
   explains native execution isn't supported for this harness/mode yet and the
   draft is preserved.
4. Type `//model` → no listbox; Enter sends the literal text `/model …` as a
   normal message.
5. Type multi-line text starting with `/x` or text where `/` isn't the first
   character → suggestions never appear; normal IME input (e.g. Japanese
   composition) is unaffected — Enter during composition must not send nor
   select.
6. **Hermes** session → `/` shows Hermes commands incl. aliases (`/new /reset`)
   and argument syntax. **Codex/Claude/OpenCode** session → header shows the
   unavailability reason and "text will be sent as an ordinary message";
   typing `/help` + Enter sends `/help` as message text (it is not a discovered
   command) — verify it appears in the transcript as a normal user message.
7. **Direct chat** → typing `/` shows no listbox at all.
8. Click **Refresh** in the listbox header → header timestamp updates; no
   network traffic occurs (discovery is file-only).
9. Relay Ctrl+K palette and the skills selector still behave unchanged; the
   composer placeholder now mentions `/ for native commands`.
