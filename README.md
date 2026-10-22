# Relay

A native Electron workspace for local and cloud agents. Multiple conversations can run **at the same time on one loaded model**. Shared weights are loaded once; conversation history, harness state, and context remain separate.

## Run

```bash
cd /home/danfl/dev/Relay
npm install
npm run build
npm start
```

For development use `npm run dev`. Node 22+ is recommended. The runtime bridge requires Python 3 and your existing LocalAi installation on Linux. `npm run dist` produces a Linux AppImage in `release/`; `npm run package` produces an unpacked desktop application.

The first launch discovers `~/dev/LocalAi` automatically. Override it in Settings or set `RELAY_LOCALAI_ROOT`. Model weights are read from your existing shared model store; Relay does not download or copy them. No inference starts until you send a message.

## Use

1. Open **Compute**, configure a model's concurrent slots and per-session KV/prefill memory allowance. Start conservatively; long-context work needs larger budgets.
2. Create a session and choose a model, harness, workspace, and recurring instructions.
3. Create another session with the **same model profile** and send a message. Both run concurrently up to that runtime's slot limit. Extra turns wait in the queue.
4. Select instructions in the composer dropdown to include them on every subsequent user turn. Change global defaults in **Instructions & skills**. Imported skills are editable copies of local `SKILL.md` content. These are prompt instructions, not executable lifecycle hooks.
5. Search conversations, pin or archive them, fork history, export Markdown, or use **Context handoff** in the session menu to continue with a short summary. Click the conversation title to rename it. `Ctrl+N` creates a session; `Ctrl+K` opens the command palette. Enter sends; Shift+Enter adds a newline.

## Harnesses and connections

| Harness | Route | Context | Tools |
|---|---|---|---|
| Direct chat | OpenAI-compatible endpoint | Full saved conversation sent on each request | None |
| Pi | Existing LocalAi provider/model configuration | Native session ID and dedicated session directory | Read-only or workspace write |
| OpenCode | Existing LocalAi provider/model configuration | Native session ID | Explicit read/write tool policy |
| Hermes | Existing Hermes CLI and local endpoint | Native session ID | Workspace write only; read-only is refused |
| Codex | Existing CLI login and optional model override | Native thread ID and explicit resume | Read-only or workspace-write sandbox |
| Claude Code | Existing CLI login and optional model override | Native session ID and explicit resume | Read tools or edit tools; shell is excluded |

Install and authenticate cloud CLIs through their own terminal workflows. Relay detects the CLI; **detection does not establish authentication, account entitlement, or available quota**. Connection failures appear in the conversation with saved partial output. The configured CLI default model is used until you choose an override in Connections. Local endpoint environment overrides are removed from cloud subprocesses.

Direct chat supports custom Ollama, llama.cpp, LM Studio, and other OpenAI-compatible endpoints. Start these servers separately and configure their actual capacity to match Relay. Remote endpoints require HTTPS. Optional API keys use Electron `safeStorage` with the OS keyring; an insecure plaintext keyring fallback is refused. Keys are never sent to the renderer or stored in conversation JSON.

Pi, OpenCode, and Hermes adapters use the installed LocalAi harness configuration. They are not universal adapters for arbitrary provider catalogs. Pi extensions and MCP are disabled in the managed subprocess so its selected tool list remains explicit. Workspace write in Pi/OpenCode/Hermes can run shell tools and is **not** an OS sandbox. Existing harness startup configuration remains trusted configuration. Claude's edit route deliberately excludes Bash. There is no unattended blanket permission bypass.

## Shared inference and hardware limits

There are three separate things:

- **Saved sessions:** lightweight conversation records; saving more does not load more model weights.
- **Resident runtime:** one model/profile process with one shared copy of its weights.
- **Active inference slots:** independent requests and KV/prefill allocations. A single large model can have multiple slots.

The scheduler uses configured slot limits, per-slot memory estimates, current available RAM, and a system reserve. Linux reads `MemAvailable`; dynamic GTT is not added to system RAM. Active reservations are conservative because actual allocations may already appear in OS telemetry. A blocked local pool does not prevent cloud work. Pause stops new admissions, and Stop cancels only the selected queued/active turn.

Relay's Python bridge imports your LocalAi controller and applies a **process-local profile override**. It passes `--sessions N` to Kyojin Qwen/GLM, or uses the controller's Gufo/llama.cpp parallel arguments. It also increases the initial footprint estimate for additional slots. It does not edit the LocalAi profile file. The controller retains PID ownership checks, initial loading checks, and its memory-pressure supervisor. Unsupported Kyojin families refuse more than one slot.

Already-running servers retain their real capacity until restarted; the scheduler caps itself to their reported session limit. Changing the UI's slot count cannot resize a live runtime. Finish active work, unload a runtime started by Relay, and send a new turn to load it with new settings. Externally started runtimes must be stopped externally with `localai stop`. The current LocalAi controller admits one managed inference profile at a time: different managed profiles wait until that slot is released. Multiple independently hosted endpoints can run concurrently within the app's memory budget.

**These are admission controls, not a measured guarantee against every memory peak.** The 4 GiB default per-slot allowance is a starting estimate, not a model-specific long-context qualification. User-selected smaller contexts require a corresponding LocalAi profile. Model/runtimes must support actual batching to improve aggregate throughput. Independent token rates can decrease when more sessions are active. Displayed token rates use reported output usage when available and are marked estimated otherwise; Codex emits completed message items rather than token-level text deltas.

Transcripts are the durable source of context. Engine KV caches remain backend-managed optimizations; Relay does not promise portable KV snapshots. Direct chat refuses a likely context overflow rather than silently trimming it. Context handoff starts a fresh child with your summary and retains the original history. Native harnesses keep their own compaction behavior. Quitting cancels outstanding turns and leaves the shared runtime resident for other clients. On restart, interrupted turns are marked explicitly and never automatically replayed. Relay persists the supervisor PID and process-start identity, so its own resident runtime can be unloaded after reopening. Stale or external process identities are refused.

## Storage and security

Electron's platform-specific user data directory stores `workspace.json`, an atomic `.bak` recovery copy, native Pi sessions, and `runtime.log`. Corrupt primary data is retained separately during recovery. Set `RELAY_DATA_DIR` to use a different directory. Conversation content and selected instruction snapshots stay out of this repository. Exported Markdown intentionally contains user and assistant text only.

The renderer uses a sandbox with context isolation and no Node integration. A narrow validated IPC bridge handles application actions. Arbitrary navigation, popups, webviews, and renderer permission requests are blocked. Markdown is rendered without raw HTML; web links open in the system browser, and executable/file URL schemes are refused. Existing providers still receive conversation content when selected.

## Verification

```bash
npm run build
npm test
python3 tests/bridge_test.py
npm run test:ui
```

The backend suite checks shared-model overlap, slot/memory queuing, cloud progress under local pressure, queued and active cancellation, recurring instruction snapshots, separate histories, recovery backups, native IDs, forks, handoffs, SSE/JSONL parsing, subprocess errors, startup races, cancellation before launch, scheduler shutdown, persisted process ownership, and 4K-context output budgeting. The Python check verifies a real multi-session Kyojin command and weight-once budgeting using a fake controller.

The UI test launches **real Electron** against an isolated mock SSE server. It verifies two overlapping turns and a queued third, context isolation, instruction toggles, forks, instruction editing, navigation, themes, responsive layout, and restart persistence. It writes screenshots in `artifacts/`. It does not use provider credentials, load weights, or qualify live GPU memory/throughput. Live native harness/model compatibility and long-context concurrency require separate tests on your intended hardware.

Protocol references: [Codex non-interactive execution](https://developers.openai.com/codex/noninteractive/), [Claude programmatic execution](https://code.claude.com/docs/en/headless), and [Electron security](https://www.electronjs.org/docs/latest/tutorial/security). Pi/Hermes/OpenCode adapters were checked against the locally installed CLI documentation and help.

## Skills, formatted outputs, and guided delegation

Relay now ships eight versioned starter skills: careful engineering, concise responses, planning, code review, verification, handoff, subagent guidance, and HTML/CSS output. Library search and workspace defaults help organize them. The composer supports session selections and next-turn-only overrides; Effective instructions shows exactly what will be sent. Each turn preserves its skill content/revision/hash. Editing a bundled skill creates a personal override; the original can be restored. Existing v1 data migrates to v2 with a permanent `.v1.bak`.

Choose **Formatted HTML** in the composer to request a static `relay-artifact` JSON block. Finished artifacts appear as cards and open in the Artifacts panel. Preview, original HTML/CSS, revision selection, responsive widths, and sanitized HTML export are available. Ordinary HTML fences have a manual preview. Generated documents are sanitized and rendered in an opaque sandbox without scripts, external resources, forms, navigation links, or the Relay bridge. Artifacts are limited to four per answer and 128 KiB each. Invalid output remains visible as source. Immutable artifact files are integrity-checked and revalidated on read/export; retain the app-data `artifacts/` directory alongside workspace backups. Unreferenced files are retained so older backups keep working.

Open **Agents** to launch up to two read-only child tasks on the parent's model and workspace. Provide their objective, context, scope, and expected result. Direct-chat children have no file tools; Hermes cannot launch read-only children. Children cannot change permissions or delegate recursively. Their results, failures, and interruptions remain visible, and **Add results to draft** lets you review them before sending. Stop individual children or the entire task tree. Time budgets include queue time. Task sessions can be archived; deletion is blocked to preserve result provenance. Agent-callable delegation is still planned and its skill remains capability-gated.

The sidebar and support panel resize with drag handles or arrow keys. The inspector starts collapsed; code blocks include highlighting, wrapping, and copy feedback. The UI supports reduced motion and activity filters.

All implementation validation uses mocks. `npm run test:ui` starts real Electron against a temporary fake provider with a guard that refuses real model profiles and native harnesses. Real-model concurrency, long-context memory, and native harness behavior require separately authorized future qualification.
