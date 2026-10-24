# Agent A — token rate log (round 4)

Runtime: LocalAI backend `qwen3.8-flash-next` (config: `~/.config/localai/backends/qwen3.8-flash-next.yaml`, `sd:127.0.0.1:8080`).

**Note on sources (found during exploration):**
- The configured runtime log path `/home/danfl/zan/ai/LocalAI/logs/localai.log` does **not exist** on this host.
- The container log (`docker logs localai`) currently shows only a 2024-10-24 `watchdog` crash-loop; the server is actually served by Ollama (`ps`: `ollama llama-server` processes, `~/.ollama/logs/server.log`), so the LocalAI per-request `prompt eval`/`eval` timing lines the README expects are not produced by the process actually serving requests.
- The only live per-request source is the OpenAI-compatible gateway log `~/logs/serve-main.log` (a vLLM-compatible `xy serve openai` gateway on port 11434). Its `handle_post_request` line reports `inputs: <prompt tokens>, total: <generated>`, and the engine log lines report `Avg. prefilled throughput` / `Avg. decoding throughput` **per iteration batch**, not per request. These are logged at INFO and captured to file, so they are logged data, not wall-clock estimates — but they are batch averages, so rows below are labelled accordingly.
- Attribution: gateway log lines carry the client port (`client: 127.0.0.1:<port>`). I attribute by lines appearing during my own generating turn and by request size (see source excerpts).

| time (UTC) | phase | prompt tokens | prefill tok/s | generated tokens | decode tok/s | source |
|---|---|---|---|---|---|---|
| 2026-10-23 22:05 | exploration (early note) | | unavailable | unavailable | unavailable | unavailable | `~/logs/serve-main.log:1877` `Post /v1/chat/completions. Inputs: 25682 tokens` (request in flight when this log was first read; no per-request throughput line yet) |
| 2026-10-24 03:34 | after implementation | 140175 | 629.3 | 366 | 37.1 | `~/.config/Relay/runtime.log` `request=r49 event=completed … prompt_tokens=140175 … prefill_tps=629.3 decode_tps=37.1` (03:34:35). |
| 2026-10-24 03:34 | completion | (see note) | unavailable | unavailable | unavailable | The rows logged at 03:34:4x belong to a second client (`prompt_tokens=69664 … prefill_tps=161.8 decode_tps=16.5`) — not my request; my final turns' completion lines had not been written when the tail was last read. Correcting rather than guessing: no claimed value. |

Attribution note (implementation/completion rows): the log shows ~1 request per 10–20s from two clients (A and B) at 03:34; the runtime serves one request at a time, so individual rows cannot be tied to my own generating turns — **both rows are unattributed (shared runtime), values are exact log values, not estimates**. The gateway (r46–r50) is the only live per-request timing source; the README-suggested LocalAI timing lines are not produced by the process actually serving these requests (see notes above).
