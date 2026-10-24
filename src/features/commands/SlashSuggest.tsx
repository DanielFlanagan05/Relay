// Composer suggestions for native harness slash commands (phase 1).
// Lists only commands discovered from the installed harness catalog by
// electron/commands.mjs. Relay navigation actions live in the Ctrl+K palette
// and instruction skills in the selector above the composer — neither appears
// in this listbox, and nothing here sends text to a model.
//
// The pure behavior (open condition, filtering, keyboard model, submit
// classification) lives in ./commandLogic.ts and is unit-tested; this file is
// the thin React shell. All rules are inline to avoid load-order coupling;
// the visual frame comes from the .slash-suggest rules in styles.css.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CatalogResult,
  NativeCommand,
  catalogStatusLine,
  classifySubmit,
  filterCommands,
  insertCommand,
  slashKeyDown,
  slashQuery,
} from "./commandLogic";

type Call = <T = unknown>(
  name: string,
  input?: unknown,
) => Promise<T | undefined>;

export function useSlashCommands({
  harness,
  sessionId,
  draft,
  setDraft,
  call,
  disabled = false,
}: {
  harness: string;
  sessionId: string;
  draft: string;
  setDraft: (text: string) => void;
  call: Call;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Direct chat has no native harness commands: no fetch, no suggestions.
  const native = harness !== "direct";
  const query = native && !disabled ? slashQuery(draft) : null;
  const commands = catalog?.commands || [];
  const filtered = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [query, commands],
  );
  useEffect(() => {
    let live = true;
    setCatalog(null);
    setDismissed(false);
    if (!native) return;
    call<CatalogResult>("commands:list", { sessionId })
      .then((result) => live && result && setCatalog(result))
      .catch(() => live && setCatalog({ harness, status: "unavailable", reason: "The local command catalog could not be read.", commands: [] }));
    return () => {
      live = false;
    };
  }, [sessionId, harness, native]);
  useEffect(() => {
    if (query === null) setDismissed(false);
  }, [query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length]);

  const open =
    query !== null && !dismissed && (filtered.length > 0 || catalog === null || catalog.status !== "complete");

  const refresh = useCallback(() => {
    if (!native) return;
    setRefreshing(true);
    call<CatalogResult>("commands:refresh", { harness })
      .then((result) => result && setCatalog(result))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [harness, native, call]);

  // Returns true when the keystroke belonged to the listbox and the composer
  // must not process it. IME-safe: ignored during composition.
  const onKeyDown = useCallback(
    (e: {
      key: string;
      preventDefault: () => void;
      nativeEvent: { isComposing: boolean };
    }) => {
      const result = slashKeyDown(
        { open, index, count: filtered.length },
        e.key,
        e.nativeEvent.isComposing,
      );
      if (!result.handled) return false;
      e.preventDefault();
      if (result.action === "select") {
        const chosen = filtered[index];
        if (chosen) {
          setDraft(insertCommand(chosen));
          setIndex(0);
        }
      } else if (result.action === "dismiss") setDismissed(true);
      else if (result.index !== undefined) setIndex(result.index);
      return true;
    },
    [open, index, filtered, setDraft],
  );

  // What an explicit submission means for the current command catalog:
  // native commands dispatch through commands:run (never into chat text);
  // "//" yields a literal "/..." message; everything else is plain text.
  const classify = useCallback(
    (text: string) => classifySubmit(text, commands),
    [commands],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const activeId = `slash-option-${index}`;
  const list = open ? (
    <div
      className="slash-suggest"
      ref={listRef}
      role="listbox"
      id="slash-suggest-listbox"
      aria-label={`Native ${harness} commands`}
      aria-activedescendant={filtered.length ? activeId : undefined}
    >
      <div className="slash-suggest-header">
        <span>
          {catalogStatusLine(catalog)}
          {catalog?.discoveredAt
            ? ` · found ${new Date(catalog.discoveredAt).toLocaleTimeString()}`
            : ""}
        </span>
        <button
          type="button"
          className="slash-suggest-refresh"
          title="Re-read the command catalog from the installed harness (local files only)"
          onClick={refresh}
          disabled={refreshing}
          onMouseDown={(e) => e.preventDefault()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {filtered.map((command, at) => (
        <SlashOption
          key={command.name}
          id={`slash-option-${at}`}
          command={command}
          harness={harness}
          active={at === index}
          onHover={() => setIndex(at)}
          onPick={() => {
            setDraft(insertCommand(command));
            setIndex(0);
          }}
        />
      ))}
      {!filtered.length && (
        <div className="slash-suggest-hint">
          {catalog && catalog.status !== "complete"
            ? "No native commands available to suggest. Text will be sent as an ordinary message; a leading // sends a literal slash."
            : `No ${harness} command starts with "/${query}". Ordinary message text — press Enter to send as typed.`}
        </div>
      )}
    </div>
  ) : null;

  return { list, onKeyDown, classify, open };
}

function SlashOption({
  id,
  command,
  harness,
  active,
  onHover,
  onPick,
}: {
  id?: string;
  command: NativeCommand;
  harness: string;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      className={`slash-suggest-option${active ? " active" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      onMouseEnter={onHover}
      title={`${command.source || `Native ${harness} command`} — Relay inserts it for you; native execution support for this harness/mode arrives in a later phase and this never becomes a chat prompt.`}
    >
      <span className="slash-suggest-name">/{command.name}</span>
      {command.aliases?.length ? (
        <span className="slash-suggest-args">
          {command.aliases.map((a) => `/${a}`).join(" ")}
        </span>
      ) : null}
      {command.args ? (
        <span className="slash-suggest-args">{command.args}</span>
      ) : null}
      <span className="slash-suggest-desc">{command.description}</span>
    </div>
  );
}
