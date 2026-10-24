# Agent B token rates

| time (UTC) | phase | prompt tokens | prefill tok/s | generated tokens | decode tok/s | source |
|---|---|---|---|---|---|---|
| 2026-10-23 19:25 | exploration (start) | 8621 (prompt) / 300 (prefill) | 534.0 | 127 | 46.7 | `~/.config/Relay/runtime.log` tail, line `[http] request=r53 event=completed ... prompt_tokens=8621 prefill_tokens=300 ... generated_tokens=127 ... prefill_tps=534.0 ... decode_tps=46.7` (this runtime hosts both Relay agent sessions; values are the runtime's own per-request timing, not wall-clock estimates) |
| 2026-10-23 19:43 | implementation complete | 93138 (prompt) / 78 (prefill, prefix-cache hit 93060) | 260.3 | 226 | 51.6 | `~/.config/Relay/runtime.log` tail, line `[http] request=r114 event=completed ... prompt_tokens=93138 prefill_tokens=78 ... generated_tokens=226 ... prefill_tps=260.3 ... decode_tps=51.6`. Note: the runtime's completed-request lines only appear between my generation bursts (one line per request); these are the freshest runtime-reported values at log time. Prefill tps here reflects a 78-token incremental prefill after a 93,060-token cache restore, so it is not comparable to a cold-prefill rate. |
