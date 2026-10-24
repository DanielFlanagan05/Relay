// Pure composer logic for native harness slash-command suggestions.
// No React, no IPC: everything here is deterministic and unit-tested in
// tests/commands.test.mjs. The backend catalog (electron/commands.mjs) is the
// only source of commands; Relay actions (Ctrl+K palette) and skills
// (instruction selectors) are separate surfaces and never appear here.

export type NativeCommand = {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
  category?: string;
  source?: string;
};

export type CatalogResult = {
  harness: string;
  status:
    | "complete"
    | "partial"
    | "unavailable"
    | "not-installed"
    | "not-applicable";
  version?: string | null;
  reason?: string | null;
  commands: NativeCommand[];
  discoveredAt?: string;
  cached?: boolean;
};

export const MAX_SUGGESTIONS = 12;

// The suggestion list is active only while the draft is a single-line token
// that starts with exactly one "/". A leading "//" is the explicit literal
// escape (the message will carry "/..."), multi-line drafts and any text
// after a space (argument entry) leave ordinary message editing untouched.
export function slashQuery(draft: string): string | null {
  const m = /^\/(?!\/)([^\s]*)$/.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

// Prefix filter over names and aliases. Name matches rank above alias
// matches; otherwise stable order preserves the harness's own registry order.
export function filterCommands(
  commands: NativeCommand[],
  query: string,
): NativeCommand[] {
  const q = (query || "").toLowerCase();
  const named: NativeCommand[] = [];
  const aliased: NativeCommand[] = [];
  for (const command of commands) {
    if (command.name.toLowerCase().startsWith(q)) named.push(command);
    else if ((command.aliases || []).some((a) => a.toLowerCase().startsWith(q)))
      aliased.push(command);
  }
  return [...named, ...aliased].slice(0, MAX_SUGGESTIONS);
}

export function insertCommand(command: NativeCommand): string {
  return `/${command.name} `;
}

export type SlashKeyState = {
  open: boolean;
  index: number;
  count: number;
};
export type SlashKeyResult = {
  handled: boolean;
  index?: number;
  action?: "select" | "dismiss";
};

// Keyboard model for the listbox. The caller checks `isComposing` (IME) and
// must not call this during composition; the guard is kept here too so an
// accidental call can never hijack an in-progress IME keystroke.
export function slashKeyDown(
  state: SlashKeyState,
  key: string,
  isComposing = false,
): SlashKeyResult {
  if (isComposing || !state.open) return { handled: false };
  if (key === "ArrowDown")
    return {
      handled: true,
      index: state.count ? (state.index + 1) % state.count : 0,
    };
  if (key === "ArrowUp")
    return {
      handled: true,
      index: state.count
        ? (state.index - 1 + state.count) % state.count
        : 0,
    };
  if (key === "Enter" || key === "Tab")
    return state.count ? { handled: true, action: "select" } : { handled: false };
  if (key === "Escape") return { handled: true, action: "dismiss" };
  return { handled: false };
}

export type SubmitIntent =
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; args: string };

// Decide what an explicit submission means. A draft whose first token is a
// discovered native command (name or alias) is dispatched as a command via
// commands:run — it must never be sent as chat text. "//" submits a literal
// leading slash as an ordinary message. Anything else (including unknown
// "/word" text the harness does not define) stays a plain message.
export function classifySubmit(
  draft: string,
  commands: NativeCommand[],
): SubmitIntent {
  const trimmed = draft.trim();
  if (trimmed.startsWith("//"))
    return { kind: "message", text: "/" + draft.slice(2) };
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
  if (m) {
    const needle = m[1].toLowerCase();
    const found = commands.find(
      (c) =>
        c.name.toLowerCase() === needle ||
        (c.aliases || []).some((a) => a.toLowerCase() === needle),
    );
    if (found)
      return { kind: "command", name: found.name, args: (m[2] || "").trim() };
  }
  return { kind: "message", text: draft };
}

export function harnessLabel(harness: string): string {
  return (
    {
      pi: "Pi",
      opencode: "OpenCode",
      hermes: "Hermes",
      codex: "Codex",
      claude: "Claude Code",
      direct: "Direct chat",
    }[harness] || harness
  );
}

// Whether the composer should offer native suggestions for a catalog at all.
export function catalogUsable(catalog: CatalogResult | null): boolean {
  return !!catalog && catalog.commands.length > 0;
}

// One-line status for the suggestion header, honest about partial data.
export function catalogStatusLine(catalog: CatalogResult | null): string {
  if (!catalog) return "Reading the local command catalog…";
  const name = harnessLabel(catalog.harness);
  switch (catalog.status) {
    case "complete":
      return `${name}${catalog.version ? ` ${catalog.version}` : ""} · discovered locally`;
    case "partial":
      return `${name} · partial catalog (discovery incomplete — refresh after a harness update)`;
    case "not-installed":
      return `${name} is not installed on this machine.`;
    case "unavailable":
      return `${name}: ${catalog.reason || "no usable local command catalog"}`;
    default:
      return "";
  }
}
