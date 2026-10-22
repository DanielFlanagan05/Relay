# Milestone E backend — tool-driven delegation (Session 1)

Implemented 2026-10-22. Backend only, Direct chat routes only, **experimental and
not qualified with a live model**. No real inference was run during development:
all verification used mock runners and one fake HTTP/SSE endpoint.

## What is now implemented

| Area | File | Summary |
| --- | --- | --- |
| Tool protocol, streamed call assembly, validation, round lifecycle, budgets | `electron/delegation.mjs` (new) | `delegate`, `task_status`, `wait_for_tasks`, `cancel_task`; OpenAI function-spec generation from the same zod schemas that validate the calls |
| Real streamed tool-call transport | `electron/adapters.mjs` | `runDirect` now sends `tools`/`tool_choice`, accumulates `delta.tool_calls` fragments, returns `{ text, toolCalls, finishReason }`, and never reads actions from answer text |
| Round loop, slot release, continuation, cancellation, gate | `electron/service.mjs` | multi-round turn execution, parked parent, continuation job, `delegationGate` |
| Task provenance and child ceilings | `electron/tasks.mjs` | `delegationId` provenance, `automated` requires Direct chat, children forced `delegation: false`, settle hook |
| Capability + honest labelling | `electron/skills.mjs` | `capabilities().delegation` is true only for an opted-in Direct session that is not a child; the `subagents` skill is delivered only then, with an experimental warning |
| Persistence and recovery | `electron/store.mjs` | `delegations[]` collection, per-session `delegation` default, rounds marked `interrupted` on load, unanswered tool calls sealed |
| IPC schema additions | `electron/main.mjs` | `delegation` accepted in `create` and `updateSession.patch` |

`electron/scheduler.mjs` and `electron/protocol.mjs` were **not** changed: the
existing pool/fairness rules already give foreground turns priority, and the
waiting state is represented as data rather than as a held scheduler job.

## Execution model

```
user turn → provider round 1 (tools advertised)
   ├─ validated calls executed locally (delegate / status / cancel)
   ├─ wait_for_tasks → park: job returns, slot released, round.status = waiting
   │        children run on the released slot
   │        last child settles → append wait result → enqueue continuation job
   │                             → provider round N+1 on the same answer message
   └─ no calls, or budget spent (final round advertises no tools) → finish
```

A parked parent is **not** in `scheduler.active` and **not** in
`scheduler.pending`; it holds nothing. That is the deadlock-free-by-construction
property, and `tests/delegation.test.mjs` records the parent's status, slot
membership and round state at the instant the child acquires the only slot.

Round/turn state lives on the assistant message as `message.protocol`, an array
of OpenAI entries:

```
{ role: "assistant", content: "…" | null, tool_calls: [{ id, type: "function", function: { name, arguments } }] }
{ role: "tool", tool_call_id, name, content }
```

Every provider round appends its own assistant entry, so continuation requests
replay the exact call/result pairs. `sealProtocol()` supplies a stub result for
any call left unanswered by cancellation, failure or restart, and
`protocolMessages()` drops still-unanswered calls from a transcript. Both are
covered by tests: no request is ever sent with a dangling `tool_calls` entry.

## Tool protocol

| Tool | Arguments (validated, strict) | Behaviour |
| --- | --- | --- |
| `delegate` | `objective` 1–2000, `context` ≤12000, `expected_result` ≤1000, `max_seconds` 30–900 | Creates a `TaskCoordinator` child session: same model/harness/workspace, `permission: "read-only"`, `delegation: false`, no `subagents`/`html-output` skills, only the supplied context. Records `automated: true` and `delegationId` |
| `task_status` | `task_id` optional | Status/result lines for the parent's own tasks only; unknown ids return an error |
| `wait_for_tasks` | `task_ids` ≤2, `timeout_seconds` 15–900 | Parks the parent; on resume the tool result is the tasks' statuses/results plus a rounds-used note. Nothing running → answered immediately |
| `cancel_task` | `task_id` | Cancels one of the parent's own tasks; partial output stays visible |

Unknown names, malformed JSON, non-object arguments, extra keys, oversized
argument buffers and calls beyond the per-round count are recorded in the
transcript with an error result and are **never** executed. When delegation is
off, the `tools` field is absent from the request, and if an endpoint returns
tool calls anyway they are dropped with a visible provider notice. JSON that
merely appears in prose is content and has no execution path.

## Budgets and ceilings

| Limit | Value | Enforcement |
| --- | --- | --- |
| Provider rounds per turn | 4 (last round has no tools) | `service.execute` loop |
| Tool calls | 6 per round, 10 per turn | `compile()` refusal + loop |
| Children per session | 2 non-terminal, 100 lifetime | `TaskCoordinator.create` |
| Delegation depth | 1 (children cannot delegate) | `taskId` checks in `tasks.create`, `capabilities()`, `delegationGate`, `enabledFor` |
| Turn elapsed | 15 min | `enforceBudgets()` retires the round, aborts the turn |
| Wait elapsed | model-chosen ≤900 s | `enforceBudgets()` cancels outstanding children, resumes with partial statuses, marks the round final |
| Argument buffer | 16 KiB/call | `ToolCallAccumulator` |
| Tool result in transcript | 6 KiB | `appendToolResult` |
| Rounds retained | 100, plus 24 h pruning | `begin()` |

`enforceBudgets()` also self-heals: a round left `waiting` with all tasks
terminal resumes immediately, and a `running` round with no scheduler job is
retired, so a session can never be locked by stale delegation state.

## Cancellation, failure and restart

- **Stop this agent** while its job is running: abort → `fail()` → round retired,
  outstanding children cancelled, protocol sealed, partial text retained.
- **Stop this agent** while parked: the round is retired, its descendants are
  cancelled, the answer becomes `stopped`, and no continuation is enqueued.
- **Stop task and children** (`cancelTaskTree`) routes through the same path.
- **Failed child**: reported in the `wait`/`task_status` result with its error;
  the parent finishes normally and the result text says which tasks failed.
  Nothing is reported as success when a child failed.
- **Wait/turn budget expiry**: outstanding children are cancelled (a one-slot
  runtime cannot let a parent resume behind its own children) and the parent is
  told the cancellation happened, so it reports partial work.
- **Restart**: `delegations` non-terminal → `interrupted` with "Children were not
  replayed"; the parent session and answer become `interrupted` as before and the
  protocol is sealed. No tool call is ever replayed automatically.

## Contract changes for UI integration (additive, nothing removed)

Nothing in `src/**` was changed; the renderer currently ignores all of this.

Snapshot (`Snapshot` type additions, all optional):

```ts
Session.delegation?: boolean;          // per-session opt-in, Direct chat only
Session.delegationRoundId?: string;    // present only while a round is live
Snapshot.delegations?: DelegationRound[];

type DelegationRound = {
  id: string;
  parentSessionId: string;
  parentAnswerId: string;
  status: "running" | "waiting" | "complete" | "failed" | "canceled" | "interrupted";
  round: number;        // provider round, 1-based
  calls: number;        // tool calls used
  children: string[];   // task ids created by this round
  waitingOn: string[];  // task ids a parked parent is waiting for
  final: boolean;       // budget spent; further calls refused
  experimental: true;   // honest labelling, always set
  qualified: false;     // never qualified with a live model yet
  createdAt: string;
  endedAt?: string;
  deadline: number;     // epoch ms
  waitUntil?: number;   // epoch ms while parked
  error: string;
};
```

Message (`Message` additions):

```ts
Message.protocol?: Array<
  | { role: "assistant"; content: string | null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; name?: string; content: string }
>;
```

`protocol` is transport fidelity, not display data. Render `Message.content` and
`Message.tools` as today: every executed delegation call already appears in
`Message.tools` as `Delegation · <tool>` with `input`, `output` and `error`.
Newest `Message.tools` entries may carry `error: ""` for successes.

IPC (existing actions, additive fields only):

- `create({ …, delegation?: boolean })`
- `updateSession({ sid, patch: { …, delegation?: boolean } })`

Waiting is displayed with existing vocabulary: a parked parent has
`status: "queued"` and `queueReason: "Waiting for N delegated task(s); the
inference slot is released"`, then `"Resuming with delegated results"`. No new
status string was introduced, so nothing in the current renderer goes blank. A
`send` while a round is open fails with "This agent is waiting on delegated
tasks. Stop the agent to take over the turn." Recommended UI follow-ups: a
per-session **Tool-driven delegation (experimental)** switch bound to
`session.delegation`, shown only when `effectiveSkills(sid).capabilities.delegation`
can be true, plus a task-tree view built from `tasks` filtered by
`delegationId` and the `delegations` records.

`capabilities()` now returns `delegation: true` only for an opted-in Direct
session; `resolveSkills` adds the warning _"Tool-driven delegation is
experimental: it is enabled for this Direct chat session and has not been
qualified with a live model."_ and, when delegation is requested on an
unsupported route, _"…unavailable on this route. Direct chat only; native harness
delegation is not supported."_.

## Checks run

```
node --test tests/*.test.mjs        # 51 pass, 0 fail (36 pre-existing + 15 new)
npx tsc --noEmit                    # clean
npx prettier --write electron/{adapters,tasks,service,skills,store,main,delegation}.mjs tests/delegation.test.mjs
```

New coverage in `tests/delegation.test.mjs`: streamed argument assembly across
indexed chunks; oversized/unknown/malformed/extra-key rejection; disabled-session
inertness plus tool-shaped prose; one-slot delegate→wait→resume with recorded
slot evidence; failed and cancelled children reported in the wait result;
status/wait/cancel scoping; child ceiling, read-only ceiling and recursion
closure; parked-parent stop with descendant cancellation and sealed protocol;
wait-budget expiry; elapsed-turn budget abort; bounded provider rounds with a tool-less final round;
restart interruption with protocol validity; `protocolMessages`/`sealProtocol`
unit behaviour; a real SSE fake-endpoint test proving `tools` is sent only when
opted in and that streamed `delta.tool_calls` fragments reassemble; skill
delivery gated on the real capability.

Not run (deliberately, per instructions): the Electron acceptance suite, the
Python bridge test, `npm run build` beyond one `tsc --noEmit`, and any real model
or provider request.

## Reviewer commands

```
npm run build                 # rebuild shared dist/ once both sessions are idle
npm test                      # 51 backend checks
python3 tests/bridge_test.py  # unchanged bridge check
npm run test:ui               # Electron acceptance against the fake provider
RELAY_FIXTURE_ENDPOINT=http://127.0.0.1:<port>/v1 npm run dev   # manual pass
```

Manual UI acceptance to add after review: opt a Direct session into delegation,
confirm the composer shows the experimental warning, ask the model to delegate,
watch one child run while the parent reads "Queued · …slot is released", stop the
parent and confirm both children stop, quit the app while waiting and confirm the
restart says "not replayed".

## Limitations and future validation

1. **No live qualification.** No OpenAI-compatible endpoint with function calling
   has actually been driven yet. Before enabling in the UI, smoke a real endpoint
   and confirm: `tool_calls` delta shapes (indexed vs unindexed, `id` in the
   first chunk), `finish_reason: "tool_calls"`, whether `tool_choice: "auto"` is
   honoured, and whether reasoning-model endpoints interleave reasoning with tool
   deltas. Record the endpoint and result in `VERIFICATION.md`.
2. **Native harnesses remain unsupported for delegation.** Pi/Codex/Claude/
   OpenCode/Hermes keep their own tool loops; Relay cannot observe or bound their
   children, so `delegationGate` refuses them. A verified bridge would need
   per-harness evidence that children can be listed, suspended and cancelled.
3. **Waiting is event-driven, not a visible queue entry.** A parked parent is not
   in the scheduler, so Compute shows it as queued with a reason but not as a job.
   If reviewers want a real queue entry, the scheduler needs a "held/gated" job
   concept — a cross-boundary change I deliberately avoided.
4. **Transcript duplication.** Per-round assistant text is stored both in
   `Message.content` (for display) and in `Message.protocol` (for the request).
   Delegation turns therefore cost roughly twice the storage of their text. A
   later storage pass could keep only `protocol` and derive `content`.
5. **Unloading the runtime while children are queued** is still possible because
   `unload()` only inspects active jobs; a queued child will fail when it starts.
   Pre-existing behaviour, now also reachable from delegation; worth a guard in
   `unload()`.
6. **No token accounting.** Budgets are rounds, calls, sizes and elapsed time.
   Usage-based budgets should reuse `Message.usage` once providers report it
   reliably, and must be labelled as estimates where they are not.
7. **Writing children are out of scope.** Children stay read-only until isolated
   worktrees or serialized file ownership exist; ownership labels alone are not
   enforcement.
8. **UI not wired.** No renderer changes were made, so the opt-in is currently
   reachable only through `create`/`updateSession`. Integration belongs to the
   UI session after review, together with `src/types.ts` additions mirroring the
   optional fields above.
