// Pure, renderer-local session/UI helpers.
// Deliberately free of React, IPC, and DOM imports so isolated UI fixtures
// (scripts/ux-smoke.mjs) can exercise the same logic the interface uses.
import type { Session } from "../../types";

export type ReadState = Record<string, string>;

export const SAFE_PARSE = <T>(raw: string | null, fallback: T): T => {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value !== null && typeof value === "object"
      ? (value as T)
      : fallback;
  } catch {
    return fallback;
  }
};

// One-time seeding so pre-existing conversations do not all appear unread.
export const seedReadState = (sessions: Session[]): ReadState =>
  Object.fromEntries(sessions.map((s) => [s.id, s.updatedAt]));

// Renderer-local unread rule: anything updated after it was last viewed,
// excluding the session currently on screen and archived conversations.
export const isUnread = (
  s: Session,
  readState: ReadState,
  selectedId: string | null,
): boolean =>
  !s.archived && s.id !== selectedId && (readState[s.id] || "") < s.updatedAt;

export const filterSessions = (
  sessions: Session[],
  opts: {
    showArchive: boolean;
    search: string;
    activityFilter: string;
    readState: ReadState;
    selectedId: string | null;
    busy: (s?: Session) => boolean;
  },
): Session[] =>
  sessions
    .filter(
      (s) =>
        s.archived === opts.showArchive &&
        (opts.activityFilter === "all" ||
          (opts.activityFilter === "active"
            ? opts.busy(s)
            : opts.activityFilter === "unread"
              ? isUnread(s, opts.readState, opts.selectedId)
              : s.status === "error" || s.status === "interrupted")) &&
        `${s.title} ${s.cwd} ${s.messages.map((m) => m.content).join(" ")}`
          .toLowerCase()
          .includes(opts.search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );

export type WorkspaceGroup = { cwd: string; sessions: Session[] };

// Groups by workspace path ("" = no workspace). Incoming order (pinned,
// then most recently updated) is preserved inside each group; groups sort by
// their most recently active session.
export const groupByWorkspace = (sessions: Session[]): WorkspaceGroup[] => {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.cwd || "";
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return [...map.entries()]
    .map(([cwd, list]) => ({ cwd, sessions: list }))
    .sort((a, b) =>
      b.sessions
        .reduce(
          (latest, s) => (s.updatedAt > latest ? s.updatedAt : latest),
          "",
        )
        .localeCompare(
          a.sessions.reduce(
            (latest, s) => (s.updatedAt > latest ? s.updatedAt : latest),
            "",
          ),
        ),
    );
};

// Explicit error recovery: the failed request is returned for review/editing
// in the composer. Nothing is re-sent automatically, so tool actions already
// applied by a harness are never replayed.
export const mergeDraftForRetry = (draft: string, lastUser?: string): string =>
  !lastUser ? draft : draft.trim() ? `${draft}\n\n${lastUser}` : lastUser;

// Platform-correct shortcut label. Callers pass navigator values so the rule
// is testable without a browser.
export const platformModKey = (platform = "", userAgent = ""): string =>
  /Mac|iPhone|iPad|iPod/.test(`${platform} ${userAgent}`) ? "⌘" : "Ctrl";

// Roving-tabindex arrow navigation for role="tablist" headers.
export const nextTab = (
  tabs: string[],
  current: string,
  key: string,
): string | null => {
  const i = tabs.indexOf(current);
  if (i < 0) return null;
  const n =
    key === "ArrowRight"
      ? (i + 1) % tabs.length
      : key === "ArrowLeft"
        ? (i + tabs.length - 1) % tabs.length
        : key === "Home"
          ? 0
          : key === "End"
            ? tabs.length - 1
            : null;
  return n === null ? null : tabs[n];
};

// Keyboard resizing for the separator handles. Returns null for unhandled keys.
export const resizeValue = (
  key: string,
  value: number,
  min: number,
  max: number,
  reverse = false,
  step = 20,
): number | null => {
  const direction = reverse ? -1 : 1;
  let next: number | null = null;
  if (key === "ArrowRight" || key === "ArrowUp")
    next = value + step * direction;
  else if (key === "ArrowLeft" || key === "ArrowDown")
    next = value - step * direction;
  else if (key === "PageUp") next = value + step * 4 * direction;
  else if (key === "PageDown") next = value - step * 4 * direction;
  else if (key === "Home") next = min;
  else if (key === "End") next = max;
  return next === null ? null : Math.max(min, Math.min(max, next));
};
