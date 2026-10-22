import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { lines, normalize } from "./protocol.mjs";
import { openaiHistory, ToolCallAccumulator } from "./delegation.mjs";
import { executable, localPaths } from "./discovery.mjs";

export function effectivePrompt(session, text, hooks) {
  const active = hooks.map((h) => `### ${h.name}\n${h.content}`).join("\n\n");
  return `Active instructions for this turn (replace prior Relay instruction selections):\n${active || "No extra instructions selected."}\n\nUser message:\n${text}`;
}
export function historySeed(session, prompt) {
  if (session.remoteId || session.messages.length < 3) return prompt;
  const messages = session.messages
    .slice(0, -2)
    .filter((m) => ["user", "assistant"].includes(m.role));
  return `Conversation carried over from a saved session:\n${messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")}\n\n${prompt}`;
}
export function commandFor(
  session,
  model,
  prompt,
  directory,
  locate = executable,
) {
  const readOnly = session.permission !== "workspace-write";
  const env = { ...process.env };
  // Cloud routes must not inherit a local proxy from the desktop's environment.
  if (["codex", "claude"].includes(session.harness)) {
    for (const key of ["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"])
      delete env[key];
    if (["local", "localai", "local-only"].includes(env.ANTHROPIC_AUTH_TOKEN))
      delete env.ANTHROPIC_AUTH_TOKEN;
    if (env.CLAUDE_CONFIG_DIR?.startsWith(join(localPaths().state, "claude")))
      delete env.CLAUDE_CONFIG_DIR;
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      if (
        env[key] &&
        (env[key].includes("compatible") ||
          env[key].startsWith("coding-") ||
          env[key].startsWith("gufo-"))
      )
        delete env[key];
    }
  }
  let args = [],
    input = null,
    cleanup,
    name = session.harness;
  if (name === "codex") {
    args = [
      "exec",
      ...(session.remoteId ? ["resume", session.remoteId] : []),
      "--skip-git-repo-check",
      "--json",
      "-c",
      `sandbox_mode="${readOnly ? "read-only" : "workspace-write"}"`,
      "-c",
      'approval_policy="never"',
      ...(model.model ? ["--model", model.model] : []),
      "-",
    ];
    input = prompt;
  } else if (name === "claude") {
    args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      readOnly ? "plan" : "acceptEdits",
      "--tools",
      readOnly ? "Read,Grep,Glob" : "Read,Grep,Glob,Edit,Write",
      ...(session.remoteId ? ["--resume", session.remoteId] : []),
      ...(model.model ? ["--model", model.model] : []),
    ];
    input = prompt;
  } else if (name === "pi") {
    env.PI_CODING_AGENT_DIR = join(localPaths().state, "pi");
    const dir = join(directory, "native", session.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    args = [
      "--mode",
      "json",
      "--print",
      "--offline",
      "--no-extensions",
      "--no-mcp",
      "--session-id",
      session.remoteId || session.nativeId || session.id,
      "--session-dir",
      dir,
      "--provider",
      "localai",
      "--model",
      model.profile || model.model,
      "--tools",
      readOnly ? "read,grep,find,ls" : "read,grep,find,ls,edit,write,bash",
    ];
    input = prompt;
  } else if (name === "opencode") {
    env.OPENCODE_CONFIG = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "localai",
      `opencode-${model.profile || model.model}.json`,
    );
    // Avoid OS argument-size limits when a fork carries a large conversation.
    const requestDir = join(directory, "requests");
    mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    cleanup = join(requestDir, `${session.id}.txt`);
    writeFileSync(cleanup, prompt, { mode: 0o600 });
    args = [
      "run",
      "--format",
      "json",
      "--model",
      `localai/${model.profile || model.model}`,
      ...(session.remoteId ? ["--session", session.remoteId] : []),
      "--file",
      cleanup,
      "--",
      "Follow the attached user request, which contains the active instructions and the message for this turn.",
    ];
    // Run permission policy is explicit; never use --auto or skip-permission flags.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: {
        "*": "deny",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        ...(readOnly ? {} : { edit: "allow", write: "allow", bash: "allow" }),
      },
    });
  } else if (name === "hermes") {
    if (readOnly)
      throw new Error(
        "Hermes has no verified read-only tool policy in this adapter. Select Workspace write explicitly or use Pi.",
      );
    env.HERMES_HOME = join(
      localPaths().state,
      "hermes-profiles",
      model.profile || model.model,
    );
    env.OPENAI_API_KEY = "local-only";
    env.OPENAI_BASE_URL = model.endpoint;
    args = [
      "chat",
      "--format",
      "stream-json",
      "--provider",
      "custom",
      "--model",
      model.profile || model.model,
      "--base-url",
      model.endpoint,
      ...(session.remoteId ? ["--resume", session.remoteId] : []),
      "--query-file",
      "-",
    ];
    input = prompt;
  } else throw new Error("Unsupported harness");
  const command = locate(name);
  if (!command)
    throw new Error(
      `${name} is not installed. Install and sign in through its CLI, then refresh Connections.`,
    );
  return { command, args, env, input, cleanup };
}

export async function runCLI({
  session,
  model,
  prompt,
  directory,
  signal,
  emit,
  commandFactory = commandFor,
}) {
  const spec = commandFactory(
    session,
    model,
    historySeed(session, prompt),
    directory,
  );
  const child = spawn(spec.command, spec.args, {
    cwd: session.cwd || undefined,
    env: spec.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "",
    errorText = "",
    sawText = false,
    spawnedError,
    closed = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr = (stderr + text).slice(-12000);
  });
  const completion = new Promise((resolve) => {
    child.on("error", (error) => {
      spawnedError = error;
    });
    child.on("close", (code, sig) => {
      closed = true;
      resolve({ code, sig });
    });
  });
  let killTimer;
  const terminate = () => {
    if (closed || killTimer) return;
    try {
      process.platform === "win32"
        ? child.kill("SIGTERM")
        : process.kill(-child.pid, "SIGTERM");
    } catch {}
    killTimer = setTimeout(() => {
      if (closed) return;
      try {
        process.platform === "win32"
          ? child.kill("SIGKILL")
          : process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 3000);
    killTimer.unref();
  };
  signal.addEventListener("abort", terminate, { once: true });
  child.stdin.on("error", () => {});
  child.stdin.end(spec.input ?? undefined);
  if (signal.aborted) terminate();
  try {
    for await (const line of lines(child.stdout)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        emit({ type: "diagnostic", value: line.slice(0, 1000) });
        continue;
      }
      for (const output of normalize(session.harness, event)) {
        if (output.type === "error") errorText = String(output.value);
        else if (output.type === "fallback") {
          if (!sawText) {
            emit({ type: "delta", value: output.value });
            sawText = true;
          }
        } else {
          if (output.type === "delta") sawText = true;
          emit(output);
        }
      }
    }
    const { code } = await completion;
    if (signal.aborted) throw new DOMException("Turn stopped", "AbortError");
    if (spawnedError) throw spawnedError;
    if (code !== 0 || errorText)
      throw new Error(
        errorText || stderr.trim() || `Harness exited with status ${code}`,
      );
    if (!sawText)
      throw new Error(
        stderr.trim() ||
          "The harness finished without an answer. Check authentication and the model selection.",
      );
  } finally {
    signal.removeEventListener("abort", terminate);
    if (!closed) {
      terminate();
      await completion;
    }
    if (killTimer) clearTimeout(killTimer);
    if (spec.cleanup) rmSync(spec.cleanup, { force: true });
  }
}

export async function runDirect({
  session,
  model,
  prompt,
  signal,
  emit,
  apiKey,
  tools = [],
  messages,
  toolArguments,
}) {
  // A delegation continuation supplies its own transcript so assistant
  // tool_calls and their tool results stay in protocol order. Otherwise the
  // conversation is rebuilt from saved history exactly as before.
  const conversation = messages || [
    ...openaiHistory(session),
    { role: "user", content: prompt },
  ];
  const size = (entry) =>
    (entry.content?.length || 0) +
    (entry.tool_calls || []).reduce((n, c) => n + (c.function?.arguments?.length || 0) + 32, 0);
  const estimate = Math.ceil(conversation.reduce((n, m) => n + size(m), 0) / 3);
  const maxTokens = Math.min(4096, model.context - estimate - 256);
  if (maxTokens < 256)
    throw new Error(
      "This conversation may exceed the model context window. Use Context handoff in the session menu to continue with a short summary. History has been kept intact.",
    );
  const response = await fetch(
    model.endpoint.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.model,
        messages: conversation,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    },
  );
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 1000);
    if (tools.length && [400, 404, 406, 415, 422].includes(response.status))
      throw new Error(
        `This endpoint rejected the tool-call request (${response.status}). Direct-chat delegation needs an OpenAI-compatible /chat/completions route with function calling. ${detail}`.trim(),
      );
    throw new Error(`Model endpoint returned ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error("No response stream from model");
  let sawText = false,
    text = "",
    finishReason = "";
  const streamed = new ToolCallAccumulator(
    toolArguments ? { maxArgumentChars: toolArguments } : {},
  );
  for await (const line of lines(response.body)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data);
    if (event.error)
      throw new Error(event.error.message || JSON.stringify(event.error));
    const delta = event.choices?.[0]?.delta;
    if (delta?.content) {
      sawText = true;
      text += delta.content;
      emit({ type: "delta", value: delta.content });
    }
    if (delta?.reasoning_content)
      emit({ type: "thinking", value: delta.reasoning_content });
    // Tool calls are read only from the protocol channel, never from answer text.
    if (delta?.tool_calls) streamed.feed(delta.tool_calls);
    if (typeof event.choices?.[0]?.finish_reason === "string")
      finishReason = event.choices[0].finish_reason;
    if (event.usage)
      emit({
        type: "usage",
        value: {
          input: event.usage.prompt_tokens,
          output: event.usage.completion_tokens,
        },
      });
    if (event.choices?.[0]?.finish_reason === "length")
      emit({
        type: "diagnostic",
        value: "Output token limit reached. Send “continue” to continue.",
      });
  }
  const calls = streamed.completed();
  if (!sawText && !calls.length)
    throw new Error(
      "The endpoint returned no answer text. Check the model chat template and output budget.",
    );
  return { text, toolCalls: calls, finishReason };
}
