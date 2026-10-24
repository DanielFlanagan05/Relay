# Local agent utilization and the three-agent experiment

## Review outcome

The three Relay sessions completed three separate slices: A built system-wide Linux RSS telemetry and the Compute graph; B added shared lifecycle status and an experimental Direct-chat opt-in control; C made provider usage cache-aware, added per-turn accounting, and refined the concise, review, subagent, and handoff instructions. Their reports are in `coordination/round2/A.report.md`, `B.report.md`, and `C.report.md`.

The collaboration experiment was productive but not friction-free. Agents exchanged interface proposals, negotiated shared-file windows, and caught a transient test parse error. Shared inboxes and claims helped when agents checked them. The mechanism is advisory, so integrations still needed review. One restart explanation was not backed by a concrete log; the teamwork skill now requires claims about interruption or lost work to cite observable evidence.

## Fixes applied after review

- Process memory uses the kernel-reported page size for `statm` fallback; zero RSS stays distinct from unavailable RSS. Permission-limited rows remain visible with unknown memory/owner. The chart scale stays tied to the largest process when sorting or searching, refresh does not restart on snapshot rerenders, failed refreshes retain the last sample, and large lists use incremental show-more pagination with search over all measured rows.
- Usage preserves absent fields, reports cached input separately, and calculates live/final turn throughput from cumulative generated tokens over active time. It excludes model startup and queue waits. Direct SSE emits only the final usage record for each request. Context occupancy is shown only for harnesses that provide a per-request context count. The displayed `tok/s` is turn throughput including prefill and tool time, not engine decode speed.
- Managed-model startup now compares the imported base footprint, extra KV slots, and configured reserve before launch, then explains the shortfall in Compute.
- Packaged skill revisions refresh only still-bundled instructions on workspace load. User-edited instructions and existing per-turn snapshots remain intact. Added `local-work` and `teamwork` instructions for focused reads, evidence-based recovery, explicit file claims, and bounded peer communication. The teamwork instruction applies only when the user authorizes shared-workspace collaboration.

## Measurements and operating guidance

The monitored two-slot run produced about 18–21 decode tokens/s per request while Gufo batched at width two. It took 66 seconds to load the model. This run used Gufo AR with speculative decoding off. Earlier measurements showed that running a second request reduced per-request decode from roughly 23–26 to 16 tokens/s on this hardware. More slots increase aggregate overlap only when the runtime has memory headroom; they do not guarantee higher per-agent speed.

Three slots needed approximately 106 GiB of model-plus-KV memory, plus the system reserve. The user approved a 6 GiB reserve for that experiment; it started successfully. The experiment ended with Relay restored to its prior 8 GiB reserve and two-slot setting. Compute now shows the startup estimate before launch so an infeasible slot count is easier to diagnose.

For future local teams:

1. Give each agent a short objective, relevant files, constraints, and an expected result. Let agents read only the relevant plan sections rather than pasting the full plan repeatedly.
2. Start with file boundaries. Allow overlap for review or interface design, but require a successful per-file claim before shared-file edits. Have one person own final integration and the broad suite.
3. Ask peers for a concrete interface decision; do not hold a scarce inference slot while polling. If a peer is queued, document an assumption and continue only on independent work.
4. Keep session context small. Search before reading large files, avoid repeated transcript/plan dumps, and write concise handoffs with file/test evidence.
5. Measure model-load time, queue delay, prefill/TTFT, decode rate, and completed work separately. Compare one- and two-slot throughput on the same task before increasing concurrency. Validate speculative decoding as a separate controlled runtime experiment.
6. Do not infer compaction from long reasoning or a quiet UI. Show it only from explicit harness events (Pi's `compaction_start`/`compaction_end` are wired since round 3).

## Verification

After the review fixes: all 101 backend tests passed; TypeScript and Vite production build passed (the existing large-chunk warning remains); bridge tests passed; the existing Electron fake-provider acceptance passed; the new isolated Electron process-chart test passed with 1,205 synthetic processes, sorting, pagination, search, polling under frequent rerenders, and failure/recovery behavior. No model was loaded or queried for review verification.

The live packaged app was not rebuilt or restarted for the feature review. Automated-delegation protocol behavior remains experimental and has not had live-provider qualification. Per-process RSS is Linux-only. (Round 3 update: Pi compaction events and the context bar are now wired; see below.)

# Round 3: two Flash-Next agents (context bar, native slash commands)

## Review outcome

- **A: context usage bar** (`src/features/context/`, 11 tests). It measures context from the last request's `contextInput`, falls back to a labelled estimate, marks stale measurements, and shows "—" when nothing is known. The code is sound. A claimed that no harness emits compaction events, which is wrong: Pi's JSON mode emits `compaction_start` and `compaction_end`. A's rate log also attributes its rows to B.
- **B: native slash commands** (`electron/commands.mjs`, `src/features/commands/`, 15 tests). It discovers commands only from files (Pi built-ins: 24, Hermes registry: 104) and caches them with version and mtime fingerprints. Phase 1 always refuses to execute a command, so the composer's "/ for native commands" hint advertises suggestions that cannot run yet. B's rate log is missing its completion row.

## Fixes applied after review

- Pi compaction is wired end to end. `protocol.mjs` maps `compaction_start` to running and `compaction_end` to done, or to failed when the event is aborted, has no result, or carries an error. `service.mjs` stores this as `session.compaction`, which feeds A's indicator. A test was added.
- The scheduler no longer double-charges a resident managed runtime. Its KV and cache were preallocated at launch, so MemAvailable already reflects them. Before this fix, B sat in "Waiting for memory headroom" while the model was loaded and idle. A test was added.
- `localai_bridge.py` now closes inherited descriptors at startup. Electron leaked its DevTools listening socket into the detached bridge, which kept the port bound after Relay quit.

All 129 tests, `tsc`, and the bridge tests pass. Nothing is committed.

## Measurements (from `~/.config/Relay/runtime.log`)

| Run | Profile / plan | Agents | Decode per stream | Wall-clock aggregate generation |
|---|---|---|---|---|
| Round 3 A | gufo-flash, MTP, serial-c1 | 1 active | 43.5 tok/s | 39.7 tok/s (27.1k tokens in 11.4 min) |
| Round 3 B | gufo-flash, MTP, serial-c1 | 1 active | 43.5 tok/s | 39.4 tok/s (50.6k tokens in 21.4 min) |
| Oct 23 01:02 | gufo-flash-ar, batched-w3 and w2 | 3 | 16.3 tok/s (w3), 18.5 tok/s (w2) | 38.6 tok/s |
| Oct 22 12:19 | gufo-flash-ar, w2 and serial | 2 | 18.5 to 25 tok/s | 27.2 tok/s |

- **Decode dominates.** About 92% of each agent's active time was generation. Prefix-cache hits covered 98–99% of input (`cacheRead` 4.17M of 4.22M for B), so prefill took under 30 s per agent. Gaps for tool execution totalled under 20 s per agent. The runtime was 98–99% busy with one agent.
- **Thinking takes about half of the output.** B produced about 92k characters of thinking against about 89k characters of tool input (the code it wrote) and 2k of visible text. A produced 54k, 41k and 2.5k.
- MTP acceptance was about 73%.

## Can we improve utilization?

**More concurrent agents on this machine will not raise throughput.** One MTP Flash agent already keeps the single slot about 99% busy at about 40 tok/s of wall-clock generation. The best batched result, three AR agents, reached 38.6 tok/s in total while each agent ran at 16 tok/s. A second agent on gufo-flash only queues behind the first. Batching would also need a second KV slot, and the Flash profile leaves about 10 GiB available against an 8 GiB reserve. Parallel local agents make sense only for latency-insensitive work, or if Gufo can batch with MTP drafting still on; none of the logged batched runs had drafting on.

**What does help, in order of expected payoff:**

1. **Generate fewer tokens.** Thinking is about 50% of decode time. Relay does not pass Pi's `--thinking` level today. A per-session or per-preset reasoning level (for example `low` for implementation turns) could cut wall time by roughly a quarter to a third. This needs a controlled A/B test on one task to check quality.
2. **Run agents one after another, not side by side.** With a single slot, queue the second agent's task behind the first rather than holding a session open. Use the gap, or a cloud model, for review.
3. **Widen the memory margin.** The LocalAi watchdog killed gufo-flash at 20:02:45 when MemAvailable fell below the 8 GiB reserve. The 12 GiB RAM cache was nearly full and Relay was relaunching. The options are lowering `cache_gib` (for example to 8), lowering the reserve, or not relaunching Relay while a runtime is loaded. This is the user's decision.
4. **Make measurement automatic.** The agents' hand-written rate logs were misattributed or incomplete. Relay should record per-request prefill and decode rates against session IDs from the runtime log instead of asking agents to log them.
5. **Keep the instructions lean.** Prefill is cheap here thanks to the cache. The extra cost of long briefs comes from the reasoning they provoke, not from reading them.
