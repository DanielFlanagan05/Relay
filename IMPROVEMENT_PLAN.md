# Relay improvement plan

Status: milestones A/B (shared skills and core UI), C (static HTML/CSS artifacts), and D (guided read-only delegation) are implemented. The build, 36 backend checks, fake-controller bridge test, and guarded fake-provider Electron acceptance pass. Remaining P1 polish and milestone E are assigned below; tool-driven delegation is not implemented yet.

Implementation testing constraint: use mock runners, temporary fake HTTP endpoints, and isolated data; do not load models for tests. The user's later request specifically authorizes starting two Qwen3.8-Flash-Next coding sessions in Relay to continue implementation. That authorization does not authorize model qualification, benchmarks, or additional test inference. Live harness/model qualification remains future work requiring a separate request.

### Handoff on October 22, 2026

See `AGENT_ASSIGNMENTS.md` for the two disjoint assignments. The current implementation deliberately keeps the `hooks` / `hookIds` storage and IPC names for compatibility while adding skill metadata and v2 migration. Artifacts use DOMPurify with jsdom and css-tree, and immutable source files under app data. Guided children are read-only and managed through the shared scheduler. No agent-callable delegation tools are exposed yet.

Still to do: milestone E backend and protocol lifecycle; the P1 workspace grouping/unread filters, refined connection status and broader accessibility polish. After the two assigned agents finish, review their changes before enabling tool-driven delegation in the UI. They should not change shared contracts outside their assigned files.


## Direction

Make Relay a workspace where users can give agents reusable working instructions, understand what every session is doing, and view useful formatted outputs alongside the conversation. Build on the existing scheduler, instruction snapshots, and Electron isolation.

Ship shared skills, focused UI improvements, and static HTML/CSS output first. Follow with app-managed delegation after its capability, scheduling, and cancellation contracts are implemented. JavaScript execution is outside the first HTML/CSS release.

## What is already present

This plan is based on the source, README, verification record, and existing `artifacts/session.png` screenshot. The screenshot is a saved acceptance artifact, not a fresh UI inspection. Existing test results were not rerun for this planning task.

| Area | Current implementation | Improvement opportunity |
| --- | --- | --- |
| Instructions | `electron/store.mjs` seeds Careful engineer, Keep it concise, and Plan first. | Versioned starter skills with clearer activation and compatibility. |
| Delivery | `electron/service.mjs` freezes selected instruction content at send time; `electron/adapters.mjs` prepends it to the prompt. | Preserve this reproducibility while adding scope, revision, and capability metadata. |
| Import | `electron/discovery.mjs` reads standalone SKILL.md files. The Library calls discovery with an empty workspace. | Discover the chosen workspace, parse metadata, and make unsupported supporting files explicit. |
| Sessions | Independent histories, forks, handoffs, queues, cancellation, and native session IDs already exist. | A fork is not a delegated task: orchestration needs separate task relationships and lifecycle. |
| Harness commands | `electron/discovery.mjs` detects installed harness executables and imports skills; the composer sends text through `effectivePrompt` and per-turn CLI subprocesses. The command palette contains Relay navigation actions. | Discover native slash commands locally, suggest them in the composer, and dispatch them as harness commands rather than model prompts. |
| Output | `Markdown` and `MessageView` in `src/App.tsx` render Markdown and code blocks without raw HTML. | Add typed artifacts and isolated previews, preserving the original text. |
| Interface | Sidebar, icon rail, session inspector, composer, compute, and connections already exist. | Reduce persistent chrome and make capabilities, errors, and next actions easier to discover. |
| Isolation | `electron/main.mjs` uses context isolation, sandboxing, no Node integration, and main-frame IPC sender validation. | Retain these protections when adding generated documents. |
| Scale | A large `App.tsx`, full workspace snapshots, and synchronous JSON persistence carry most behavior. | Extract feature modules and measure update/storage costs as transcripts and artifacts grow. |

## 1. Shared agent skills

### Starter library

Ship these as bundled, readable SKILL.md files plus a small manifest. Keep the existing skill IDs where possible so saved selections survive. Do not overwrite user-edited instructions when updating bundled content.

| Skill | Initial behavior | Activation |
| --- | --- | --- |
| Terse responses | Lead with the answer; remove filler; include only useful explanation and material limitations. | Optional session default; replaces the presentation of Keep it concise. |
| Careful implementation | Inspect first, make focused changes, preserve unrelated work, run relevant checks, accurately report results. | Preserve the current default for existing users. |
| Code review | Find actionable defects introduced by the change; rank severity; cite precise locations, impact, and evidence. Do not edit unless asked. | Task skill, enabled for a review turn or review session. |
| Plan before changes | State intended outcome, approach, dependencies, and important uncertainty before implementation; distinguish planning-only requests. | Explicit selection; no automatic approval pause for routine work. |
| Use subagents | Delegate independent bounded work, define ownership and expected results, wait for results, verify integration, and observe configured limits. | Available only when a verified delegation capability exists; otherwise explain the limitation and proceed sequentially. |
| Verify and report | Choose checks proportional to the change; distinguish passed, failed, and not run; never invent validation. | Optional task skill; avoid repeating identical instructions from Careful implementation. |
| Context handoff | Summarize objective, decisions, relevant files, completed work, constraints, and concrete next steps. | Explicit handoff action; user can inspect/edit the generated summary. |
| HTML/CSS output | Produce accessible, self-contained formatted output in Relay's artifact format, with a short textual explanation. | Automatically selected when the user chooses formatted output, visibly shown in the composer. |

Suggested initial content for three key skills:

**Terse responses**

> Lead with the result. Use the shortest response that fully answers the request. Omit filler, repeated summaries, and unnecessary headings. Include commands, evidence, risks, or uncertainty when they affect the user's next decision. Expand when the user requests detail; never omit necessary information just to be brief.

**Code review**

> Review the requested diff and enough surrounding code to understand its behavior. Prioritize correctness, regressions, security, and missing verification of meaningful behavior. Report actionable findings with severity, file and line, triggering conditions, impact, and supporting evidence. Separate confirmed problems from questions. Do not manufacture findings or focus on style unless requested. If no actionable findings remain, say so and identify material validation gaps. Do not modify code unless asked.

**Use subagents**

> Use only delegation tools actually provided by this session. Delegate when independent work will benefit from separate context or parallel execution. Give each child a bounded task, necessary context, file ownership, constraints, and expected result. Respect Relay's concurrency and budget limits. Keep dependent work sequential, avoid overlapping edits, collect results, and verify the integrated outcome. Do not claim a child ran when no delegation tool was available. Cancel unnecessary children and report unresolved work.

These are product skill drafts, not instructions enabling delegation in this planning session.

### Selection and precedence

Provide three distinct concepts in the UI: **response preferences**, **task skills**, and **session presets**. Preferences such as terse output can persist. Skills such as code review can apply to the next turn or the whole session. Presets select compatible combinations without adding another layer of duplicated prompt text.

Resolve Relay selections in this order: application defaults → workspace defaults → session overrides → next-turn overrides. Each level can explicitly disable an inherited item. Application defaults continue to initialize new sessions; changing them must not silently modify existing conversations. Workspace selection should likewise be captured when a session is created or explicitly refreshed.

Deduplicate by skill ID, retain deterministic order, and detect incompatible modes such as review-only plus an implementation preset. A current user request can override response preferences, but cannot expand app-enforced permissions. Relay cannot promise control over a native harness's higher-priority instructions; show what Relay supplied separately from harness configuration.

Before sending, offer an **Effective instructions** view showing selected content, source, scope, revision, approximate token cost, and incompatible capabilities. At send time, freeze the resolved content as today. Edits while a turn is queued affect only subsequent turns. Disabling an instruction stops future injection; it does not erase its historical influence in a resumed native conversation. Offer a fresh session/handoff when a clean context is needed.

### Model and delivery

Evolve the internal `Hook` concept to `Skill` through an explicit workspace-version migration. Proposed fields:

```ts
type Skill = {
  id: string;
  revision: number;
  name: string;
  description: string;
  body: string;
  category: 'style' | 'workflow' | 'output';
  origin: 'bundled' | 'user' | 'imported';
  sourcePath?: string;
  contentHash: string;
  requires: string[];
};
```

Store resolved revision/hash/body snapshots per turn, including in frontend types. Preserve legacy hook snapshots and IDs. New bundled skills should appear for existing users without resetting their selections. Keep bundled originals immutable; editing creates a personal override with an update comparison.

Start with explicit prompt injection for all supported routes; do not silently install files into global harness directories. Export a selected skill or bundle as SKILL.md files when requested. Later, adapters may use native skill discovery where it is verified, with exactly one delivery path per skill to avoid duplicate injection.

Keep short preferences active every turn. Larger skills should initially be explicitly selected rather than indiscriminately loaded. A future skill-list/read tool can support on-demand loading for capable harnesses; direct chat currently has no tool loop, so it must continue receiving the selected body directly.

Import should parse name/description frontmatter, show provenance and content before activation, deduplicate by path/hash, and include the selected workspace's directories. First release supports instruction-only skills: flag references to scripts or supporting files instead of implying those dependencies were imported. A later bundle importer needs path containment, symlink checks, size limits, and a separate policy for executable resources.

**Acceptance:** Existing sessions and edited defaults survive migration; imported workspace skills are discoverable; a queued turn retains its original snapshot; unknown capabilities are not advertised as available; instruction-only skills work through direct chat and each tested CLI adapter.

## 2. UI and interaction improvements

Preserve the existing visual identity. Prioritize usable space and clear state over a broad redesign.

| Priority | Change | Result |
| --- | --- | --- |
| P0 | Make the right inspector a collapsible, resizable panel with Details, Artifacts, and later Agents tabs. Default it closed for ordinary chat; open it when the user requests an artifact. | More conversation space and one consistent place for supporting work. |
| P0 | Compress the tall session header; persist sidebar and panel widths. Collapse the sidebar at narrow sizes. | Less scrolling and room for previews at the existing 1024px minimum window width. |
| P0 | Put model, agent/harness, permissions, skills, and output format in a compact composer toolbar. Show unavailable combinations with a reason. | Users can understand the next turn before sending. |
| P0 | Differentiate queued, loading model, generating, waiting for children, failed, and interrupted. Show a reason and appropriate action. | A waiting session no longer looks like a stalled answer. |
| P0 | Use truthful connection labels: CLI detected, connection untested, verified at time, or failed. | Detection is no longer confused with authentication or readiness. |
| P0 | Add Library search, category filters, scope controls, revision/provenance details, and effective-instruction preview. | Skills remain usable beyond the three current starter cards. |
| P1 | Add expandable navigation labels, platform-correct shortcuts, stronger secondary-text contrast, reduced-motion support, and keyboard-operable panel resizing. | Better discoverability and accessibility. |
| P1 | Group sessions by workspace; retain existing search, pin, archive, fork, and handoff. Add activity/unread filters. | Easier navigation as concurrent work grows. |
| P1 | Add syntax highlighting, wrap toggles, code language labels, reliable copy feedback, and readable table overflow. | Better technical output without requiring HTML for every answer. |
| P1 | Improve errors with retained draft, provider details on demand, and explicit retry behavior. | Recovery without losing work or accidentally repeating tool actions. |
| P1 | Add a per-process memory bar graph to the page opened by clicking **Local compute**. Include all running system processes, including non-AI applications and background services. | Users can see which processes are consuming system memory and reducing available headroom. |
| P1 | Discover installed harnesses' default slash commands locally, suggest matching commands as the user types `/`, and route selected commands through the active harness's command interface. | Familiar native session controls stay available in Relay and follow installed harness updates without web requests. |
| P1 | Show each session's context usage as `<context used> / <context available>` at the bottom-right immediately above the text entry box, with explicit compaction status. | Users can see how much of the context window is occupied and when conversation context has been compacted. |

Keep the existing scroll-follow behavior when the reader is near the bottom; show a jump-to-latest indicator when they are reading earlier content. Keep reasoning and tool details collapsed by default, but show concise progress separately from the answer. Remove the hard-coded user initial from message rendering.

New-session defaults should reuse the last compatible model/workspace. Offer simple **Chat**, **Implement**, **Review**, and **Plan** presets, with actual capabilities visible. A Review preset selects the code-review skill and a compatible read-only route; an unsupported read-only harness cannot be made safe merely by adding a prompt.

For retries, distinguish resending a user request from resuming a native session. Interrupted tool use may have already changed files; never automatically replay it.

**Acceptance:** All primary flows work by keyboard; focus returns correctly from dialogs and panels; light/dark themes and 200% zoom remain usable; session/queue state is understandable without opening Compute; opening an artifact preserves the conversation position and composer draft.

### Session context usage and compaction

Every session must display its current context usage at the **bottom-right immediately above the text entry box**. Use the format **`<context used> / <context available>`**, with token units clearly identified (for example, `24,000 / 128,000 tokens`). Here, context available means the session's total usable context-window capacity, not the remaining free tokens. Keep the indicator visible while idle, queued, and running, and update it when usage or the active model/context limit changes. Preserve readability at narrow widths and 200% zoom without overlapping composer controls.

Report the context currently retained for the next inference, including instructions and tool content where measurable, rather than cumulative lifetime input/output tokens. Prefer usage and context-limit telemetry from the active harness/provider. Distinguish measured values from estimates and label unavailable or stale information explicitly; do not invent precise counts or silently substitute cumulative billing usage for context occupancy. Where estimation is necessary, account for injected skills, history, and tool messages and visibly mark the value as approximate.

When automatic or user-triggered compaction occurs, show **Compacting context…** while a confirmed operation is in progress and **Context compacted** after confirmed completion beside the usage indicator. Update the count to reflect the retained context after compaction, and keep the last compaction time available so the user can tell it happened after the transient progress state ends. A failed operation must show failure rather than successful compaction. Detect native compaction through harness events or verified adapter metadata; a decrease in token count alone is not proof of compaction. Persist the last confirmed compaction status/time with the session, distinguish a fresh session or model switch from compaction, and use an accessible status announcement when compaction completes.

**Acceptance:** Each session shows its own usage/capacity above the composer at the required location; switching sessions never carries another session's values across. Mock telemetry verifies updates after turns, context/model-limit changes, and compaction, including progress, success, failure, resumed sessions, stale data, and unavailable/estimated metrics. Verify the displayed usage represents retained context rather than lifetime token consumption, and that compaction is explicitly reported and remains discoverable after completion. Check keyboard/screen-reader usability, narrow layouts, and zoom using fixtures without loading models or running inference.

### Native harness slash commands

Current source inspection: `electron/discovery.mjs` checks executable availability and discovers SKILL.md files, but does not enumerate native commands. The composer in `src/App.tsx` has no slash-command completion; its separate command palette lists Relay navigation actions. `AgentService.send` wraps every submitted message in `effectivePrompt`, and `electron/adapters.mjs` launches a headless subprocess per turn with stdin closed after submitting the prompt. There is no dedicated native-command IPC action, command catalog, or persistent command channel. Native slash-command discovery and execution therefore need implementation, not just a suggestion dropdown.

**Composer behavior:** Typing `/` at the start of a composer request opens keyboard-accessible suggestions for the active session's harness; further typing filters command names and aliases. Show the native description, argument syntax, and any required interaction, and support arrow keys, Enter/Tab selection, and Escape dismissal without breaking ordinary message entry or IME input. Completion inserts the command and allows argument entry before explicit submission. Keep catalogs scoped to the selected harness/version/configuration and distinguish native built-ins from skills, custom commands, and Relay actions. Preserve slash text in code blocks, quoted examples, and ordinary prose as message content; provide an explicit way to send a leading slash literally. Direct chat has no native harness commands.

**Local discovery and automatic updates:** Implement a catalog provider for each supported installed harness (Pi, OpenCode, Hermes, Codex, and Claude Code). Prefer a supported local command-enumeration API, SDK, or machine-readable protocol, including session initialization metadata where available. Where that is absent, inspect installed command manifests, registries, bundled help/completion metadata, or package resources through a version-aware reader. CLI `--help` options alone must not be mistaken for an interactive slash-command catalog. Determine which sources actually exist for each installed harness before choosing its integration; do not assume every harness exposes introspection or that importing its executable/package is safe or side-effect-free. Run any discovery subprocess with bounded time/output and without model inference or network requests.

Cache discovered command names, aliases, descriptions, argument metadata, source, installed version, and discovery time locally. Invalidate on executable/package/version or relevant configuration changes, recheck when Connections refreshes or a harness session starts, and expose a manual refresh. Use a file fingerprint when version information is unavailable. Avoid scanning on every keystroke. Refreshes must not require web requests. Prefer the installed source of truth over a hand-maintained universal command list; if an installation exposes no usable local catalog, show discovery as unavailable or incomplete and support only explicitly version-verified fallbacks. Label stale cached results and revalidate support before execution.

**Native execution:** Add a typed, validated command-dispatch IPC action separate from `send`. Route the command name and arguments directly to the active harness session through its supported native command/control interface, without instruction injection, history seeding, LLM interpretation, or a shell. Do not assume piping `/model` or `/exit` into an existing headless prompt invocation executes an interactive command. Add a persistent protocol/SDK bridge, or an interactive adapter where necessary, and verify command support for each execution mode. Discoverability and executability are separate capabilities: commands requiring unsupported terminal interactions must show a reason rather than silently becoming chat prompts. Native picker/menu commands need a Relay interaction that submits the user's choice back through the harness interface.

Match the installed harness's semantics and command names/aliases. For example, `/exit`, where supported, ends that agent session and cancels its pending/active work, releases its scheduler reservations, and records a closed state while retaining its transcript; it must not quit Relay or stop other sessions. `/model`, where supported, opens the native model-selection flow or accepts its native argument syntax, changes the model through the harness, and synchronizes Relay's displayed selection and scheduler/memory accounting after success. Preserve native conversation continuity where supported; make any required fresh-session transition explicit. Never substitute an approximate prompt instruction for a control operation.

Process native acknowledgments, picker responses, errors, and session lifecycle events even when no assistant text is produced; the current runner treats an empty answer as failure. Record command outcomes separately from inference messages, handle commands during queued/running turns according to native capabilities, and avoid automatically replaying control commands after restart. Control commands such as exit must not wait for an inference slot. Preserve existing permission, session-ownership, model-compatibility, and shared-runtime constraints throughout command execution.

**Acceptance:** With fake installed harness catalogs and protocol fixtures, verify `/` suggestions and prefix filtering, aliases/arguments, keyboard behavior, harness switching, literal slash messages, and separation from Relay actions and skills. Simulate an installed harness update that adds/removes commands and confirm local refresh updates suggestions without network access. Test missing/stale/partial catalogs and unsupported execution modes. Verify commands reach the native command interface unchanged and bypass `effectivePrompt` and inference; `/exit` closes only its target session and frees reservations, and `/model` updates both native and Relay state only after successful selection. Cover native menus, error/no-text responses, cancellation, and restart behavior without loading models. Native parity remains unverified until separately authorized smoke checks establish behavior for each enabled harness/version/mode.

### Local compute: memory usage by process

On the page opened by clicking **Local compute**, add a horizontal bar graph showing the current physical memory usage of each running process across the system. Include **all processes**, not just AI models, inference servers, Relay sessions, or Relay's own process tree: browsers, editors, background services, and other users' processes must also appear where the operating system permits inspection.

Use one bar per process, labeled with its name, PID, and measured memory in MiB/GiB. Sort by memory usage descending by default and use a consistent, clearly labeled scale. Keep the complete process list accessible through a scrollable chart and name/PID search; do not silently truncate to a top-N list or merge processes with the same name. Provide accessible text values alongside bars so the information is usable without color or a pointer.

Refresh while the Local compute page is visible at a bounded interval, showing the last successful update and any collection errors. Handle processes starting or exiting between samples. Collect system-wide process metrics in the Electron backend through platform-supported APIs or tools, and pass only display data through the validated IPC bridge. Permission-limited or unavailable measurements must be labeled explicitly rather than shown as zero or silently omitted; do not require elevated privileges for the page to work.

Keep total, used, and available system memory visible beside the chart so users can relate individual processes to available headroom. Label the per-process metric precisely (for example, resident memory/RSS or working set, depending on platform). Explain that shared pages may be counted in more than one process and that kernel/cache memory is not fully represented by process bars, so their sum need not equal system memory used. Keep measured process usage distinct from scheduler/model reservation estimates.

**Acceptance:** Clicking **Local compute** displays the graph; mocked system samples containing both AI and unrelated processes show every process with its name, PID, and memory value. Verify descending order, complete-list access/search, refresh after process start/exit, duplicate names with distinct PIDs, empty/error/permission-limited states, and keyboard/screen-reader access. Use mocked collectors and isolated fixtures; do not load models or run inference to verify this feature.

## 3. HTML + CSS formatted AI outputs

### User experience

Add **Output: Auto / Markdown / Formatted HTML** to the composer. Auto retains Markdown unless an answer contains an explicit valid artifact. Formatted HTML supplies the artifact-output skill. Ordinary HTML examples remain code unless explicitly previewed; never interpret every HTML-looking answer as application UI.

An artifact appears as a compact inline preview/card with **Open**, **Source**, and **Export**. Opening uses the right panel, with Preview, HTML, and CSS tabs, adjustable viewport width, and an expand action. A follow-up can request changes to that artifact; completed revisions remain selectable. Use host-owned labels and controls so generated content cannot imitate Relay's toolbar outside its frame.

Start with static layouts: reports, comparison tables, styled explanations, checklists, and simple diagrams built from HTML/CSS. Include semantic headings and table markup, readable contrast, responsive layout, and print styles in the output skill. Use a scrollable bounded preview rather than enabling scripts just to measure content height.

### Artifact contract

Use a dedicated fenced `relay-artifact` block containing versioned JSON:

```json
{
  "version": 1,
  "type": "html-css",
  "title": "Implementation options",
  "html": "<main><h1>Implementation options</h1><p>...</p></main>",
  "css": "main { max-width: 64rem; margin: auto; padding: 2rem; }"
}
```

Normalize into a persisted artifact record with app-assigned ID, session/message association, revision, original source, and validation result. Do not trust model-provided filesystem paths or identifiers to choose where anything is stored. Store artifact bodies separately from the frequently rewritten workspace metadata using atomic writes and recoverable metadata updates. Include artifacts in backup/recovery behavior and handle orphaned files deliberately.

Use structured adapter events later where available; the fenced contract works with current text streams. Parse only a complete closed block; do not preview partial streaming HTML. Invalid JSON, unsupported versions, or rejected content remain visible as source with a concise error. Avoid implicit model repair calls. For existing ordinary HTML fences, offer a manual Preview action through the same validation pipeline.

Initial proposed limits: 128 KiB per artifact, four artifacts per answer, and a bounded document/style complexity budget. Validate and benchmark these limits before release. Parsing should be incremental or deferred until completion, not repeated over the full transcript for every token. Preserve source text for transcript export, and export the sanitized static preview as a standalone HTML file. Do not automatically open unsanitized output in the system browser.

### Rendering boundary

Use a dedicated `ArtifactFrame` with `iframe sandbox=""` and sanitized `srcdoc`; omit both `allow-scripts` and `allow-same-origin`. Do not put generated markup into Relay's main DOM. Sandboxing gives the embedded document restricted capabilities and an opaque origin when same-origin access is not allowed. [MDN iframe reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)

Construct the document wrapper and its CSP in trusted application code. Start with `default-src 'none'`, `script-src 'none'`, `style-src 'unsafe-inline'`, `connect-src 'none'`, `font-src 'none'`, `img-src 'none'`, `object-src 'none'`, `frame-src 'none'`, `form-action 'none'`, and `base-uri 'none'`. Images can follow as separately validated local raster attachments; they are not needed for the HTML/CSS MVP. Verify parent/child CSP interaction in the packaged Electron build before choosing the minimal host `frame-src` policy. [MDN CSP guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSP)

Use a maintained HTML sanitizer with a restrictive element/attribute allowlist and a real CSS parser for policy enforcement, not regex-only filtering. Strip scripts, event handlers, forms, iframes, embedded objects, base/meta/link tags, external resource URLs, CSS imports, and active SVG content. Parse HTML and CSS separately and safely serialize them into the trusted wrapper; test closing-tag injection through CSS. Links in the first static preview are inert; expose validated links separately through trusted UI if needed. Block navigation, downloads, popups, and resource loads as defense in depth. Do not assume CSP alone blocks every navigation path.

Keep Node integration disabled, context isolation and process sandboxing enabled, and the existing main-frame-only IPC check. Generated frames receive no preload bridge or privileged message commands. Preserve sender validation even if future preview infrastructure changes. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security/)

**Acceptance:** Reports and tables render correctly across themes and widths; CSS cannot affect Relay; previews cannot access `window.relay`, navigate the app, submit forms, open windows, execute scripts, read local files, or make network requests, including to localhost. Verify malicious HTML/CSS fixtures, oversized documents, malformed streaming blocks, persistence/recovery, and sanitized export in real Electron. Set an explicit performance threshold and fall back to source for excessive complexity.

Interactive JavaScript outputs are a separate future project requiring a stronger execution boundary and resource controls. They must not be enabled by relaxing this static preview's sandbox.

## 4. Subagent orchestration

A subagent skill describes good delegation; actual delegation requires app services and adapter support. The current scheduler limits independent sessions, while `parentId` already represents forks/handoffs. Introduce separate task records rather than overloading that relationship.

Proposed task data: root session, parent task, child session, objective, expected result, workspace/file scope, selected skill snapshots, capability policy, status, limits, and result summary. Start with one level of children and at most two children per root task, also subject to existing pool/memory limits. Use the same model by default; changing a managed profile may stall behind the current runtime and must be surfaced explicitly.

Deliver in two stages:

1. **User-launched delegation:** A Delegate action creates one or two bounded child sessions, initially read-only. Users inspect their results and explicitly bring summaries into the parent conversation. This uses existing adapters without pretending they expose agent-callable tools.
2. **Agent-launched delegation:** Add validated `delegate`, `status`, `wait`, and `cancel` tools via an adapter-supported bridge. Expose them only on verified routes. Direct chat needs an explicit tool-call execution loop before it qualifies. Native harness delegation should remain a separate capability unless Relay can track and constrain its child lifecycle.

All Relay-managed children use the shared scheduler and memory accounting. Foreground conversations need fair access so child fan-out cannot consume every slot indefinitely. A parent waiting on children must yield its inference slot before their execution; do not hold the sole slot while waiting. Initial orchestration should finish the parent planning turn, run children, and enqueue a continuation after results arrive. If a CLI cannot suspend/release/resume safely, mark that orchestration mode unsupported rather than bypassing limits.

Children inherit equal or narrower permissions and explicit relevant context, not every transcript or credential. Start with read-only analysis/review. Writing children later require isolated worktrees where supported, or serialized edits with explicit file ownership; ownership labels alone are not filesystem enforcement. The parent integrates and validates results.

Define **Stop this agent** and **Stop task and children** separately. Persist child lifecycle and result provenance. On restart, mark interrupted work without automatically replaying tools. Bound task depth, child count, output/context size, and elapsed runtime; enforce token limits only where usage is available and label estimates honestly. A failed child should produce a visible partial result and recovery choice, not a silent successful parent summary.

**Acceptance:** One-slot runtimes cannot deadlock; cancellation reaches descendants; child crashes do not orphan active reservations; foreground work progresses; permissions cannot expand through delegation; results and failures survive restart; parent summaries identify unresolved findings. The Agents panel shows the task tree, state, elapsed time, and result links.

## 5. Delivery sequence

| Milestone | Work | Exit condition |
| --- | --- | --- |
| A — Contracts and migration | Extract focused skill/message components from `App.tsx`; define skill, capability, and artifact schemas; add a backed-up workspace migration. | Existing sessions, native IDs, defaults, and snapshots survive upgrade and recovery. |
| B — Skills and core UX | Starter library, scope controls, workspace discovery, effective instructions, composer toolbar, collapsible panels, clearer status/errors. | A user can start a review with known capabilities and inspect exactly which instructions will be sent. |
| C — Static formatted outputs | Artifact contract/parser, persistence, sanitizer/CSS policy, isolated preview, source/revisions/export. | Formatted reports work and the Electron isolation tests pass. This completes the first product release. |
| D — Guided delegation | Task records, user-created read-only children, task panel, result collection, cancellation and fairness. | A user can delegate two bounded tasks and incorporate results without slot leaks or deadlock. |
| E — Tool-driven delegation | Verified adapter bridges, parent continuation, capability gating, budgets; writing children only after isolation is ready. | The subagent skill can drive real tracked delegation on explicitly supported routes. |

Suggested file boundaries: `electron/skills.mjs` for resolution/import; `electron/artifacts.mjs` for validation/storage; `electron/tasks.mjs` for orchestration; `src/features/skills/`, `src/features/artifacts/`, `src/features/conversation/`, and `src/features/tasks/` for UI. Keep migrations explicit in `electron/store.mjs`, IPC schemas in `electron/main.mjs`, and admission logic in `electron/scheduler.mjs`. Extend `package.json`'s package file list to include bundled skills and any runtime assets.

For each milestone, run the existing build and backend suites plus targeted Electron acceptance checks. Add tests for behavior and boundaries, not prompt wording. Native delivery/delegation requires live smoke tests for each enabled harness; mocked transport tests alone do not establish compatibility. Measure long-transcript rendering and snapshot/storage overhead before choosing virtualization, event deltas, or a database migration.

First implementation slice: preserve and version the current three instructions, add Code review, expose next-turn/session scope, and make the inspector collapsible. Then add the complete static artifact path. Defer skill marketplaces, automatic global harness installation, executable skill bundles, arbitrary JavaScript, and autonomous recursive delegation until their supporting contracts are ready.
