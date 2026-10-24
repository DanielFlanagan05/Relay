import { inclusiveInput } from "./usage.mjs";
import { StringDecoder } from "node:string_decoder";

// Split on LF only: JSON string values can contain Unicode paragraph separators.
export async function* lines(stream) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer +=
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
    }
    if (buffer.length > 32 * 1024 * 1024)
      throw new Error("Provider event exceeds 32 MiB");
  }
  buffer += decoder.end();
  if (buffer) yield buffer;
}
export function normalize(harness, event) {
  const result = [];
  const add = (type, value) => {
    if (value !== undefined && value !== "") result.push({ type, value });
  };
  if (event.thread_id) add("remoteId", event.thread_id);
  if (event.session_id) add("remoteId", event.session_id);
  if (event.sessionID) add("remoteId", event.sessionID);
  if (harness === "pi") {
    if (event.type === "session") add("remoteId", event.id);
    const e = event.assistantMessageEvent;
    if (e?.type === "text_delta") add("delta", e.delta);
    if (e?.type === "thinking_delta") add("thinking", e.delta);
    if (event.type === "tool_execution_start")
      add("tool", { name: event.toolName, input: event.args });
    if (event.type === "tool_execution_end")
      add("tool", {
        name: event.toolName,
        output: event.result,
        error: event.isError,
      });
    if (event.type === "compaction_start") add("compaction", "running");
    if (event.type === "compaction_end")
      add(
        "compaction",
        event.result && !event.aborted && !event.errorMessage
          ? "done"
          : "failed",
      );
    if (event.type === "message_end" && event.message?.role === "assistant") {
      add("usage", {
        input: inclusiveInput(
          event.message.usage?.input,
          event.message.usage?.cacheRead,
          event.message.usage?.cacheWrite,
        ),
        contextInput: inclusiveInput(
          event.message.usage?.input,
          event.message.usage?.cacheRead,
          event.message.usage?.cacheWrite,
        ),
        scope: "request",
        reasoning: event.message.usage?.reasoning,
        output: event.message.usage?.output,
        // Passed through only when this harness actually reports them.
        cacheRead: event.message.usage?.cacheRead,
        cacheWrite: event.message.usage?.cacheWrite,
      });
      if (["error", "aborted"].includes(event.message.stopReason))
        add("error", event.message.errorMessage || event.message.stopReason);
    }
  } else if (harness === "codex") {
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "agent_message")
      add("delta", item.text + "\n\n");
    if (
      item &&
      [
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
      ].includes(item.type)
    )
      add("tool", {
        name: item.type,
        input: item.command || item.changes || item.arguments,
        output: item.aggregated_output,
        status: item.status,
      });
    if (event.type === "turn.completed")
      add("usage", {
        input: event.usage?.input_tokens,
        scope: "turn",
        output: event.usage?.output_tokens,
        cacheRead: event.usage?.cached_input_tokens,
        reasoning: event.usage?.reasoning_output_tokens,
      });
    if (event.type === "error" || event.type === "turn.failed")
      add(
        "error",
        event.message || event.error?.message || "Codex turn failed",
      );
  } else if (harness === "claude") {
    const delta = event.event?.delta;
    if (delta?.type === "text_delta") add("delta", delta.text);
    if (delta?.type === "thinking_delta") add("thinking", delta.thinking);
    if (event.type === "assistant") {
      for (const b of event.message?.content || [])
        if (b.type === "tool_use")
          add("tool", { name: b.name, input: b.input });
    }
    if (event.type === "result") {
      if (event.is_error)
        add(
          "error",
          event.result || event.errors?.join("\n") || "Claude turn failed",
        );
      if (event.permission_denials?.length)
        add("tool", {
          name: "Permission required",
          output: event.permission_denials,
        });
      add("fallback", event.result);
      add("usage", {
        input: inclusiveInput(
          event.usage?.input_tokens,
          event.usage?.cache_read_input_tokens,
          event.usage?.cache_creation_input_tokens,
        ),
        scope: "turn",
        output: event.usage?.output_tokens,
        cacheRead: event.usage?.cache_read_input_tokens,
        cacheWrite: event.usage?.cache_creation_input_tokens,
      });
    }
  } else if (harness === "opencode") {
    if (event.type === "text") add("delta", event.part?.text || event.text);
    if (event.type === "tool_use")
      add("tool", {
        name: event.part?.tool,
        input: event.part?.state?.input,
        output: event.part?.state?.output,
      });
    if (event.type === "step_finish")
      add("usage", {
        input: event.part?.tokens?.input,
        output: event.part?.tokens?.output,
        cacheRead: event.part?.tokens?.cache?.read,
        cacheWrite: event.part?.tokens?.cache?.write,
      });
    if (event.type === "error")
      add(
        "error",
        event.error?.data?.message ||
          event.error?.message ||
          "OpenCode turn failed",
      );
  } else if (harness === "hermes") {
    if (event.type === "text") add("delta", event.text);
    if (["tool_use", "tool_result"].includes(event.type))
      add("tool", {
        name: event.name,
        input: event.input,
        output: event.output,
      });
    if (event.type === "result") {
      add("fallback", event.text);
      add("usage", event.tokens);
      if (event.exit_code || event.error)
        add("error", event.error || "Hermes turn failed");
    }
  }
  return result;
}
