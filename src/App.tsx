import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code2,
  Command,
  Copy,
  Cpu,
  Download,
  Ellipsis,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  Layers,
  LayoutGrid,
  ListFilter,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  Pause,
  Pin,
  Play,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Trash2,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import { TaskPanel } from "./features/tasks/TaskPanel";
import { ArtifactPanel } from "./features/artifacts/ArtifactPanel";
import { SkillSelector } from "./features/skills/SkillSelector";
import { SkillLibrary } from "./features/skills/SkillLibrary";
import { Markdown } from "./features/conversation/Markdown";
import { useSlashCommands } from "./features/commands/SlashSuggest";
import {
  latestOutcome,
  outcomeLine,
  outcomeVisible,
} from "./features/commands/commandOutcomes";
import {
  DelegationToggle,
  StatusNotice,
  StatusPill,
} from "./features/status/SessionStatusUI";
import {
  deriveSessionStatus,
  openRoundFor,
  statusLabelFor,
} from "./features/status/sessionStatus";
import { ResizeHandle } from "./components/ResizeHandle";
import { ContextUsage } from "./features/context/ContextUsage";
import { ProcessMemory } from "./features/compute/ProcessMemory";
import {
  SAFE_PARSE,
  filterSessions,
  groupByWorkspace,
  isUnread,
  mergeDraftForRetry,
  nextTab,
  platformModKey,
  seedReadState,
  type ReadState,
} from "./features/sessions/sessionLogic";
import {
  THINKING_LEVELS,
  type Hook,
  type Message,
  type Model,
  type Session,
  type Settings,
  type Snapshot,
  type ThinkingLevel,
} from "./types";

type View = "sessions" | "compute" | "connections" | "library" | "settings";
const busy = (s?: Session) =>
  !!s && ["running", "loading", "queued"].includes(s.status);
const short = (m?: Model) =>
  m?.name.split(" · ").slice(0, 2).join(" · ") || "Select model";
const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
const basename = (p: string) =>
  p.split("/").filter(Boolean).at(-1) || "No workspace";
// Native slash-command outcomes (phase 2) are stored on the session, never
// as chat messages; this renders the newest one while it is still recent.
function CommandOutcomeBlock({ session }: { session: Session }) {
  const entry = latestOutcome(session.commandLog);
  if (!outcomeVisible(entry, Date.now())) return null;
  return (
    <div
      className={cx(
        "command-outcome",
        entry!.status !== "ok" && "failed",
      )}
      role="status"
    >
      <span>{outcomeLine(entry!)}</span>
      <time dateTime={entry!.at}>{new Date(entry!.at).toLocaleTimeString()}</time>
    </div>
  );
}

const cx = (...v: (string | false | undefined)[]) =>
  v.filter(Boolean).join(" ");
const modKey = platformModKey(
  navigator.platform || "",
  navigator.userAgent || "",
);
const PANEL_TABS = ["details", "artifacts", "agents"];
const formatTool = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={cx("brand-mark", small && "small")}>
      <span />
      <span />
      <span />
    </div>
  );
}
function IconButton({
  children,
  title,
  onClick,
  active = false,
  disabled = false,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx("icon-button", active && "selected")}
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  description,
  children,
  close,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current
      ?.querySelector<HTMLElement>("input,select,textarea,button")
      ?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const nodes = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,textarea,[tabindex="0"]',
          ) || []),
        ];
        if (!nodes.length) return;
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0].focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className={cx("modal", wide && "wide")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton title="Close dialog" onClick={close}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export function App() {
  const [data, setData] = useState<Snapshot>();
  const [fatal, setFatal] = useState("");
  const [view, setView] = useState<View>("sessions");
  const [selected, setSelected] = useState<string | null>(
    localStorage.getItem("relay.session"),
  );
  const [search, setSearch] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(
    Math.max(
      200,
      Math.min(360, Number(localStorage.getItem("relay.sidebarWidth")) || 250),
    ),
  );
  const [panelTab, setPanelTab] = useState("details");
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(
    Math.max(
      280,
      Math.min(720, Number(localStorage.getItem("relay.panelWidth")) || 360),
    ),
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [navLabels, setNavLabels] = useState(
    localStorage.getItem("relay.navLabels") === "true",
  );
  const [activityFilter, setActivityFilter] = useState("all");
  // Renderer-local read state: which conversations were viewed when, used for
  // unread badges and the unread filter. Never sent to the main process.
  const [readState, setReadState] = useState<ReadState | null>(() =>
    SAFE_PARSE<ReadState | null>(localStorage.getItem("relay.readState"), null),
  );
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >(() =>
    SAFE_PARSE<Record<string, boolean>>(
      localStorage.getItem("relay.collapsedWorkspaces"),
      {},
    ),
  );
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    localStorage.setItem("relay.sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("relay.panelWidth", String(panelWidth));
  }, [panelWidth]);
  useEffect(() => {
    localStorage.setItem("relay.navLabels", String(navLabels));
  }, [navLabels]);
  useEffect(() => {
    if (readState)
      localStorage.setItem("relay.readState", JSON.stringify(readState));
  }, [readState]);
  useEffect(() => {
    localStorage.setItem(
      "relay.collapsedWorkspaces",
      JSON.stringify(collapsedGroups),
    );
  }, [collapsedGroups]);
  const [showArchive, setShowArchive] = useState(false);
  const [newSession, setNewSession] = useState(false);
  const [inspector, setInspector] = useState(
    localStorage.getItem("relay.inspector") === "true",
  );
  useEffect(
    () => localStorage.setItem("relay.inspector", String(inspector)),
    [inspector],
  );
  const [board, setBoard] = useState(false);
  const [palette, setPalette] = useState(false);
  const [toast, setToast] = useState("");
  const [editingHook, setEditingHook] = useState<Hook | null>(null);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [more, setMore] = useState(false);
  const notify = (message: string) => setToast(message);
  async function call<T = unknown>(
    name: string,
    input: unknown = {},
  ): Promise<T | undefined> {
    try {
      const result = await window.relay.call<T>(name, input);
      if (["create", "fork", "handoff"].includes(name))
        setData(await window.relay.call<Snapshot>("snapshot"));
      return result;
    } catch (error) {
      notify((error as Error).message);
      return undefined;
    }
  }
  useEffect(() => {
    if (!window.relay) {
      setFatal(
        "Open Relay in Electron with npm start or npm run dev. The browser preview does not have access to agents.",
      );
      return;
    }
    window.relay
      .call<Snapshot>("snapshot")
      .then(setData)
      .catch((e) => setFatal(e.message));
    return window.relay.subscribe(setData);
  }, []);
  useEffect(() => {
    if (selected) localStorage.setItem("relay.session", selected);
  }, [selected]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 6500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setNewSession(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!more) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMore(false);
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [more]);
  useEffect(() => {
    document.documentElement.dataset.theme = data?.settings.theme || "dark";
  }, [data?.settings.theme]);
  const session = data?.sessions.find((s) => s.id === selected);
  const model = data?.models.find((m) => m.id === session?.modelId);
  const active = data?.sessions.filter(busy).length || 0;
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const visibleSessionId =
    view === "sessions" && !board && documentVisible ? selected : null;
  useEffect(() => {
    // First snapshot: treat everything as read so old sessions do not all
    // arrive flagged as unread.
    if (data && readState === null) setReadState(seedReadState(data.sessions));
  }, [data, readState]);
  useEffect(() => {
    if (!session || visibleSessionId !== session.id) return;
    const at = session.updatedAt;
    setReadState((r) =>
      r && r[session.id] === at ? r : { ...(r || {}), [session.id]: at },
    );
  }, [session?.id, session?.updatedAt, visibleSessionId]);
  const filtered = useMemo(
    () =>
      filterSessions(data?.sessions || [], {
        showArchive,
        search,
        activityFilter,
        readState: readState || {},
        selectedId: visibleSessionId,
        busy,
      }),
    [
      data?.sessions,
      showArchive,
      search,
      activityFilter,
      readState,
      visibleSessionId,
    ],
  );
  const workspaceGroups = useMemo(() => groupByWorkspace(filtered), [filtered]);
  const open = (sid: string) => {
    setSelected(sid);
    setView("sessions");
    setBoard(false);
    setMore(false);
  };
  const update = (patch: Partial<Session>) =>
    session && call("updateSession", { sid: session.id, patch });
  const saveSettings = (patch: Partial<Settings>) =>
    data && call("settings", { ...data.settings, ...patch });
  if (!data)
    return (
      <div className="boot">
        <Brand />
        <h2>{fatal || "Opening your workspace"}</h2>
        {!fatal && <LoaderCircle className="spin" />}
      </div>
    );
  return (
    <div
      className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${navLabels ? "nav-expanded" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--panel-width": `${panelWidth}px`,
        } as React.CSSProperties
      }
    >
      <nav className="rail" aria-label="Main navigation">
        <button
          className="brand-button"
          title="Relay"
          onClick={() => setView("sessions")}
        >
          <Brand small />
        </button>
        <div className="rail-nav">
          {(
            [
              ["sessions", MessageSquare, "Sessions"],
              ["compute", Cpu, "Compute"],
              ["connections", Unplug, "Connections"],
              ["library", BookOpen, "Instructions & skills"],
            ] as const
          ).map(([name, Icon, title]) => (
            <IconButton
              key={name}
              title={title}
              active={view === name}
              onClick={() => setView(name)}
            >
              <Icon size={21} />
              <span className="nav-label">{title}</span>
            </IconButton>
          ))}
        </div>
        <div className="rail-bottom">
          <IconButton
            title={`Command palette (${modKey}+K)`}
            onClick={() => setPalette(true)}
          >
            <Command size={19} />
          </IconButton>
          <IconButton
            title="Settings"
            active={view === "settings"}
            onClick={() => setView("settings")}
          >
            <Settings2 size={21} />
          </IconButton>
          <IconButton
            title="Toggle navigation labels"
            onClick={() => setNavLabels(!navLabels)}
          >
            <ListFilter size={18} />
          </IconButton>
          <IconButton
            title="Toggle session sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Layers size={18} />
          </IconButton>
        </div>
      </nav>
      <aside className="sidebar">
        <div className="workspace-heading">
          <div>
            <h1>
              Relay<span className="beta">BETA</span>
            </h1>
            <p>Your agent workspace</p>
          </div>
          <span className="status-light" title="Workspace saved locally" />
        </div>
        <button className="new-session" onClick={() => setNewSession(true)}>
          <Plus size={17} />
          New session
          <kbd>{modKey} N</kbd>
        </button>
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label="Search sessions"
            placeholder="Search anything…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setView("sessions");
            }}
          />
          <kbd>{modKey} K</kbd>
        </div>
        <div className="session-label">
          <button onClick={() => setShowArchive((v) => !v)}>
            {showArchive ? "ARCHIVED" : "YOUR SESSIONS"}
            <ChevronDown size={12} />
          </button>
          <span>{filtered.length}</span>
          <IconButton
            title="Toggle session overview"
            active={board}
            onClick={() => {
              setBoard((v) => !v);
              setView("sessions");
            }}
          >
            <LayoutGrid size={14} />
          </IconButton>
        </div>
        <select
          className="activity-filter"
          aria-label="Filter sessions"
          value={activityFilter}
          onChange={(e) => setActivityFilter(e.target.value)}
        >
          <option value="all">All sessions</option>
          <option value="active">Active sessions</option>
          <option value="unread">Unread activity</option>
          <option value="attention">Needs attention</option>
        </select>
        <div className="session-list">
          {workspaceGroups.map((group) => {
            const collapsed = !!collapsedGroups[group.cwd];
            return (
              <div
                className="workspace-group"
                key={group.cwd || "no-workspace"}
              >
                <button
                  className="workspace-group-heading"
                  aria-expanded={!collapsed}
                  title={group.cwd || "No workspace selected"}
                  onClick={() =>
                    setCollapsedGroups((c) => ({
                      ...c,
                      [group.cwd]: !c[group.cwd],
                    }))
                  }
                >
                  <ChevronDown
                    size={11}
                    className={
                      collapsed ? "group-chevron collapsed" : "group-chevron"
                    }
                  />
                  <Folder size={11} />
                  <strong>{basename(group.cwd)}</strong>
                  <span>{group.sessions.length}</span>
                </button>
                {!collapsed &&
                  group.sessions.map((s) => {
                    const m = data.models.find((m) => m.id === s.modelId);
                    return (
                      <button
                        className={cx(
                          "session-row",
                          selected === s.id &&
                            view === "sessions" &&
                            !board &&
                            "active",
                          isUnread(s, readState || {}, visibleSessionId) &&
                            "unread",
                        )}
                        key={s.id}
                        onClick={() => open(s.id)}
                      >
                        <span className={cx("session-state", s.status)}>
                          {busy(s) ? (
                            <LoaderCircle
                              size={15}
                              className={s.status !== "queued" ? "spin" : ""}
                            />
                          ) : (
                            <MessageSquare size={15} />
                          )}
                        </span>
                        <span className="session-row-text">
                          <strong>{s.title}</strong>
                          <span>
                            {m?.kind === "cloud" ? (
                              <Cloud size={11} />
                            ) : (
                              <Cpu size={11} />
                            )}{" "}
                            {short(m)}
                            <span className="row-dot">·</span>
                            {busy(s)
                              ? statusLabelFor(s, data.delegations, data.tasks)
                              : basename(s.cwd)}
                          </span>
                        </span>
                        {isUnread(s, readState || {}, visibleSessionId) && (
                          <span
                            className="unread-dot"
                            aria-label="Unread activity"
                            title="Unread activity"
                          />
                        )}
                        {s.pinned && <Pin size={11} className="muted" />}
                      </button>
                    );
                  })}
              </div>
            );
          })}
          {!filtered.length && (
            <div className="sidebar-empty">
              <MessageSquare size={20} />
              <p>
                {search
                  ? "No matching sessions"
                  : showArchive
                    ? "No archived sessions"
                    : "A little room to think."}
              </p>
              <span>
                {!search && !showArchive && "Start a conversation above."}
              </span>
            </div>
          )}
        </div>
        <div
          className="sidebar-compute"
          onClick={() => setView("compute")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && setView("compute")}
        >
          <div className="compute-mini-heading">
            <Cpu size={15} />
            <strong>Local compute</strong>
            <ArrowUpRight size={14} />
          </div>
          <div className="memory-mini">
            <span>
              {data.runtime ? "Model resident" : "Ready when you are"}
            </span>
            <span>{active} active</span>
          </div>
          <div className="meter">
            <span
              style={{
                width: `${Math.min(100, 100 * (1 - data.memory.availableGiB / data.memory.totalGiB))}%`,
              }}
            />
          </div>
          <div className="memory-mini">
            <span>{data.memory.availableGiB.toFixed(1)} GiB available</span>
            <span>{data.memory.totalGiB.toFixed(0)} GiB</span>
          </div>
        </div>
        <footer className="sidebar-footer">
          <span className="tiny-dot" />
          Saved on this device
          <ShieldCheck size={13} />
        </footer>
      </aside>
      {sidebarOpen && (
        <ResizeHandle
          label="Resize session sidebar"
          value={sidebarWidth}
          change={setSidebarWidth}
          min={200}
          max={360}
        />
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <Layers size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {view === "sessions"
                ? board
                  ? "Session overview"
                  : session?.title || "New possibilities"
                : {
                    compute: "Compute",
                    connections: "Connections",
                    library: "Instructions & skills",
                    settings: "Settings",
                  }[view]}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="live-badge">
              <span />
              {active
                ? `${active} session${active > 1 ? "s" : ""} working`
                : "No active turns"}
            </span>
            <button
              className="shortcut"
              aria-label="Open command palette"
              title={`Open command palette (${modKey}+K)`}
              onClick={() => setPalette(true)}
            >
              <Command size={13} /> {modKey}
            </button>
          </div>
        </header>
        {view === "sessions" && !board && session ? (
          <>
            <div className="session-header">
              <div className="title-and-meta">
                <div className="eyebrow">
                  {model?.kind === "cloud" ? "CLOUD SESSION" : "LOCAL SESSION"}
                  {session.parentId && <span> / FORKED</span>}
                </div>
                <h2
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-label="Session title"
                  onBlur={(e) => {
                    const title = e.currentTarget.textContent
                      ?.trim()
                      .slice(0, 250);
                    if (title && title !== session.title) update({ title });
                    else e.currentTarget.textContent = session.title;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                >
                  {session.title}
                </h2>
                <div className="session-meta">
                  <span>
                    <Folder size={13} />
                    {session.cwd || "No workspace selected"}
                  </span>
                  <span className="tag">{session.harness}</span>
                  <StatusPill
                    status={deriveSessionStatus({
                      session,
                      round: openRoundFor(session.id, data.delegations),
                      tasks: data.tasks,
                    })}
                    fallback={session.status}
                  />
                </div>
              </div>
              <div className="session-actions">
                <IconButton
                  title={session.pinned ? "Unpin session" : "Pin session"}
                  active={session.pinned}
                  onClick={() => update({ pinned: !session.pinned })}
                >
                  <Pin size={17} />
                </IconButton>
                <IconButton
                  title="Fork conversation"
                  onClick={async () => {
                    const sid = await call<string>("fork", { sid: session.id });
                    if (sid) open(sid);
                  }}
                >
                  <GitBranch size={17} />
                </IconButton>
                <IconButton
                  title="Open agents panel"
                  onClick={() => {
                    setPanelTab("agents");
                    setInspector(true);
                  }}
                >
                  <GitBranch size={17} />
                </IconButton>
                <IconButton
                  title="Toggle session details"
                  active={inspector}
                  onClick={() => setInspector((v) => !v)}
                >
                  <SlidersHorizontal size={17} />
                </IconButton>
                <div className="relative" ref={moreRef}>
                  <IconButton
                    title="More session actions"
                    aria-expanded={more}
                    onClick={() => setMore((v) => !v)}
                  >
                    <Ellipsis size={20} />
                  </IconButton>
                  {more && (
                    <div className="popover menu">
                      <button
                        onClick={() => {
                          call("export", { sid: session.id });
                          setMore(false);
                        }}
                      >
                        <Download size={14} />
                        Export Markdown
                      </button>
                      <button
                        onClick={() => {
                          setHandoff(true);
                          setMore(false);
                        }}
                      >
                        <FileText size={14} />
                        Context handoff
                      </button>
                      <button
                        onClick={() => {
                          update({ archived: !session.archived });
                          setMore(false);
                        }}
                      >
                        {session.archived
                          ? "Restore session"
                          : "Archive session"}
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          setDeleteId(session.id);
                          setMore(false);
                        }}
                      >
                        <Trash2 size={14} />
                        Delete session
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="conversation-layout">
              <Conversation
                key={session.id}
                session={session}
                model={model}
                data={data}
                call={call}
                notify={notify}
                openArtifact={(id) => {
                  setSelectedArtifact(id);
                  setPanelTab("artifacts");
                  setInspector(true);
                }}
              />
              {inspector && (
                <ResizeHandle
                  label="Resize details panel"
                  value={panelWidth}
                  change={setPanelWidth}
                  min={280}
                  max={720}
                  reverse
                />
              )}
              {inspector && (
                <aside className="support-panel">
                  <div
                    className="support-tabs"
                    role="tablist"
                    aria-label="Session panels"
                  >
                    {PANEL_TABS.map((tab) => (
                      <button
                        key={tab}
                        role="tab"
                        id={`support-tab-${tab}`}
                        aria-controls="support-panel-body"
                        aria-selected={panelTab === tab}
                        tabIndex={panelTab === tab ? 0 : -1}
                        onKeyDown={(e) => {
                          const next = nextTab(PANEL_TABS, panelTab, e.key);
                          if (!next) return;
                          e.preventDefault();
                          setPanelTab(next);
                          document
                            .getElementById(`support-tab-${next}`)
                            ?.focus();
                        }}
                        onClick={() => setPanelTab(tab)}
                      >
                        {tab === "details"
                          ? "Details"
                          : tab === "artifacts"
                            ? "Artifacts"
                            : "Agents"}
                      </button>
                    ))}
                  </div>
                  <div
                    id="support-panel-body"
                    role="tabpanel"
                    aria-labelledby={`support-tab-${panelTab}`}
                  >
                    {panelTab === "agents" ? (
                      <TaskPanel
                        session={session}
                        data={data}
                        call={call}
                        open={open}
                        notify={notify}
                      />
                    ) : panelTab === "artifacts" ? (
                      <ArtifactPanel
                        session={session}
                        selected={selectedArtifact}
                        select={setSelectedArtifact}
                        notify={notify}
                      />
                    ) : (
                      <SessionInspector
                        session={session}
                        model={model}
                        data={data}
                        update={update}
                      />
                    )}
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : view === "sessions" && board ? (
          <div className="page">
            <PageHeading
              eyebrow="A BIRD’S-EYE VIEW"
              title="Every session. One workspace."
              description="Follow concurrent agents without losing the thread."
              action={
                <button
                  className="button primary"
                  onClick={() => setNewSession(true)}
                >
                  <Plus size={15} />
                  New session
                </button>
              }
            />
            <div className="session-grid">
              {filtered.map((s) => (
                <button
                  className="session-card"
                  key={s.id}
                  onClick={() => open(s.id)}
                >
                  <div>
                    <span className={cx("state-label", s.status)}>
                      <span />
                      {s.status}
                    </span>
                    <ArrowUpRight size={15} />
                  </div>
                  <h3>{s.title}</h3>
                  <p>
                    {s.messages
                      .filter((m) => m.role === "assistant")
                      .at(-1)
                      ?.content.slice(0, 170) || "Ready for your next idea."}
                  </p>
                  <footer>
                    <span>
                      {short(data.models.find((m) => m.id === s.modelId))}
                    </span>
                    <span>
                      {s.messages.filter((m) => m.role === "user").length} turns
                    </span>
                  </footer>
                </button>
              ))}
            </div>
            {!filtered.length && (
              <EmptyState
                title="Your sessions will appear here"
                detail="Start a few agents and follow their work in parallel."
              />
            )}
          </div>
        ) : view === "sessions" ? (
          <Welcome
            data={data}
            create={() => setNewSession(true)}
            go={setView}
          />
        ) : view === "compute" ? (
          <Compute data={data} call={call} edit={setEditingModel} />
        ) : view === "connections" ? (
          <Connections data={data} call={call} edit={setEditingModel} />
        ) : view === "library" ? (
          <SkillLibrary
            cwd={session?.cwd || ""}
            data={data}
            call={call}
            edit={setEditingHook}
            saveSettings={saveSettings}
          />
        ) : (
          <SettingsPage data={data} call={call} save={saveSettings} />
        )}
      </main>
      {newSession && (
        <NewSession
          data={data}
          call={call}
          close={() => setNewSession(false)}
          created={open}
        />
      )}
      {handoff && session && (
        <HandoffDialog
          session={session}
          call={call}
          close={() => setHandoff(false)}
          created={open}
        />
      )}
      {editingHook && (
        <HookEditor
          hook={editingHook}
          call={call}
          close={() => setEditingHook(null)}
        />
      )}
      {editingModel && (
        <ModelEditor
          model={editingModel}
          call={call}
          close={() => setEditingModel(null)}
        />
      )}
      {palette && (
        <CommandPalette
          sessions={data.sessions}
          open={(sid) => {
            open(sid);
            setPalette(false);
          }}
          close={() => setPalette(false)}
          create={() => {
            setPalette(false);
            setNewSession(true);
          }}
          go={(v) => {
            setView(v);
            setPalette(false);
          }}
        />
      )}
      {deleteId && (
        <Modal
          title="Delete this conversation?"
          description="The conversation will be removed from Relay. Export it first if you want to keep a copy."
          close={() => setDeleteId(null)}
        >
          <div className="modal-footer">
            <button className="button" onClick={() => setDeleteId(null)}>
              Keep session
            </button>
            <button
              className="button destructive"
              onClick={async () => {
                const result = await call("remove", { sid: deleteId });
                if (result !== undefined) {
                  setDeleteId(null);
                  setSelected(null);
                }
              }}
            >
              Delete session
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="alert">
          <Activity size={17} />
          <span>{toast}</span>
          <IconButton title="Dismiss notification" onClick={() => setToast("")}>
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <Layers size={27} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function Welcome({
  data,
  create,
  go,
}: {
  data: Snapshot;
  create: () => void;
  go: (v: View) => void;
}) {
  const installed = data.models.filter(
    (m) => m.kind === "local" && m.installed,
  ).length;
  return (
    <div className="welcome">
      <div className="welcome-content">
        <div className="welcome-orbit">
          <div className="orbit-ring one" />
          <div className="orbit-ring two" />
          <Brand />
          <span className="orbit-point" />
        </div>
        <div className="eyebrow">MANY MINDS. ONE WORKSPACE.</div>
        <h2>
          Good ideas deserve
          <br />
          <span>a little more compute.</span>
        </h2>
        <p>
          A home for your agents. Run sessions side by side,
          <br />
          keep your context, and work with the models you choose.
        </p>
        <button className="button primary welcome-start" onClick={create}>
          <Plus size={17} />
          Start a session
          <ArrowRight size={17} />
        </button>
        <div className="welcome-shortcut">
          or press <kbd>{modKey}</kbd>
          <kbd>N</kbd>
        </div>
        <div className="welcome-features">
          <button onClick={() => go("compute")}>
            <div className="feature-icon violet">
              <Layers size={19} />
            </div>
            <h3>One model, many sessions</h3>
            <p>
              Shared weights. Independent context. Hardware-aware concurrency.
            </p>
            <span>
              Explore compute
              <ArrowUpRight size={12} />
            </span>
          </button>
          <button onClick={() => go("library")}>
            <div className="feature-icon amber">
              <Sparkles size={19} />
            </div>
            <h3>Instructions that stay</h3>
            <p>Your selected skills and instructions travel with every turn.</p>
            <span>
              Build your library
              <ArrowUpRight size={12} />
            </span>
          </button>
          <button onClick={() => go("connections")}>
            <div className="feature-icon green">
              <Unplug size={19} />
            </div>
            <h3>Local meets cloud</h3>
            <p>Pi, Hermes, OpenCode, Codex, and Claude. One place to work.</p>
            <span>
              Manage connections
              <ArrowUpRight size={12} />
            </span>
          </button>
        </div>
        <div className="welcome-status">
          <span className="tiny-dot" />
          {installed} installed local profiles<span>·</span>
          {
            data.harnesses.filter((h) => h.available && h.id !== "direct")
              .length
          }{" "}
          harnesses detected<span>·</span>Context saved locally
        </div>
      </div>
    </div>
  );
}

type Call = <T = unknown>(
  name: string,
  input?: unknown,
) => Promise<T | undefined>;
function Conversation({
  session,
  model,
  data,
  call,
  notify,
  openArtifact,
}: {
  session: Session;
  model?: Model;
  data: Snapshot;
  call: Call;
  notify: (text: string) => void;
  openArtifact: (id: string) => void;
}) {
  const [draft, setDraft] = useState(session.draft || "");
  useEffect(() => setDraft(session.draft || ""), [session.draftRevision]);
  const [sending, setSending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null);
  const pinnedToBottom = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inFlight = busy(session);
  // Native harness slash-command suggestions (local catalog only). The pure
  // behavior lives in src/features/commands/; direct chat gets no suggestions.
  const slash = useSlashCommands({
    harness: session.harness,
    sessionId: session.id,
    draft,
    setDraft,
    call,
    disabled: session.archived || !!session.taskId,
  });
  // One derivation for the whole session view: queued, loading, generating,
  // waiting for children, stopped, interrupted - never a guess.
  const status = deriveSessionStatus({
    session,
    round: openRoundFor(session.id, data.delegations),
    tasks: data.tasks,
  });
  const pool = data.pools.find((p) => p.modelId === session.modelId);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (draft !== session.draft)
        call("updateSession", { sid: session.id, patch: { draft } });
    }, 500);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    if (pinnedToBottom.current)
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "instant",
      });
  }, [session.messages]);
  async function send() {
    if (!draft.trim() || inFlight || sending || session.taskId) return;
    // A draft whose first token is a discovered native command dispatches via
    // commands:run and is never sent as chat text; "//" sends a literal slash.
    const intent = slash.classify(draft);
    if (intent.kind === "command") {
      try {
        const result = await call<{ reason?: string }>("commands:run", {
          sessionId: session.id,
          name: intent.name,
          args: intent.args,
        });
        notify(result?.reason || `/${intent.name} was not executed.`);
      } catch (e) {
        notify((e as Error).message);
      }
      return;
    }
    setSending(true);
    try {
      await window.relay.call("send", { sid: session.id, text: intent.text });
      setDraft("");
    } catch (e) {
      notify((e as Error).message);
    }
    setSending(false);
    textarea.current?.focus();
    pinnedToBottom.current = true;
  }
  return (
    <section className="conversation">
      <CommandOutcomeBlock session={session} />
      <div
        className="messages"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current!;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          setAwayFromBottom(!pinnedToBottom.current);
        }}
      >
        {!session.messages.length && (
          <div className="conversation-empty">
            <div className="feature-icon violet">
              <Sparkles size={24} />
            </div>
            <h3>What are we working on?</h3>
            <p>
              Your context stays with this session.
              <br />
              Open another to work in parallel with the same model.
            </p>
            <div className="prompt-suggestions">
              {[
                "Explore this project and explain its structure",
                "Help me turn an idea into a concrete plan",
                "Review the code and find opportunities to improve",
              ].map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    setDraft(prompt);
                    textarea.current?.focus();
                  }}
                >
                  {prompt}
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {session.messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            harness={session.harness}
            notify={notify}
            openArtifact={openArtifact}
          />
        ))}
        {session.error && (
          <div className="inline-error" role="alert">
            <Activity size={17} />
            <div className="error-body">
              <strong>This turn needs attention</strong>
              <span>
                Your conversation and draft are saved. Relay will not repeat
                tool actions on its own — interrupted work may already have
                changed files.
              </span>
              <details className="error-details">
                <summary>Connection and provider details</summary>
                <pre>{session.error}</pre>
                <button
                  className="button"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(session.error || "")
                      .then(() => notify("Error details copied"))
                  }
                >
                  Copy details
                </button>
              </details>
              <div className="error-actions">
                {session.messages.some((m) => m.role === "user") && (
                  <button
                    className="button"
                    title="Returns your last request to the composer for review. Nothing is sent automatically."
                    onClick={() => {
                      const lastUser = [...session.messages]
                        .reverse()
                        .find((m) => m.role === "user")?.content;
                      setDraft((d) => mergeDraftForRetry(d, lastUser));
                      textarea.current?.focus();
                    }}
                  >
                    Edit last request
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* `session.error` already renders the fuller inline error card above. */}
        {status.state !== "failed" && <StatusNotice status={status} />}
      </div>
      {awayFromBottom && (
        <button
          className="jump-latest button"
          onClick={() => {
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
            pinnedToBottom.current = true;
            setAwayFromBottom(false);
          }}
        >
          <ArrowDown size={14} />
          Jump to latest
        </button>
      )}
      <div className="composer-area">
        <div className="composer-top">
          <SkillSelector session={session} data={data} notify={notify} />
          <select
            aria-label="Session permissions"
            title={
              session.harness === "direct"
                ? "Direct chat has no file tools"
                : "Agent permissions"
            }
            value={session.permission}
            disabled={
              inFlight ||
              session.harness === "direct" ||
              session.harness === "hermes"
            }
            onChange={(e) =>
              call("updateSession", {
                sid: session.id,
                patch: { permission: e.target.value },
              })
            }
          >
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
          </select>
          <DelegationToggle
            session={session}
            busy={inFlight}
            rounds={data.delegations}
            tasks={data.tasks}
            update={(patch) =>
              call("updateSession", { sid: session.id, patch })
            }
          />
          {session.harness === "pi" && (
            <ThinkingSelect
              value={session.thinking || "default"}
              disabled={inFlight}
              onChange={(thinking) =>
                call("updateSession", { sid: session.id, patch: { thinking } })
              }
            />
          )}
          <select
            aria-label="Output format"
            value={session.outputFormat}
            onChange={(e) =>
              call("updateSession", {
                sid: session.id,
                patch: { outputFormat: e.target.value },
              })
            }
          >
            <option value="auto">Output: Auto</option>
            <option value="markdown">Markdown</option>
            <option value="html">Formatted HTML</option>
          </select>
          <div className="active-hook-tags">
            {session.hookIds.slice(0, 2).map((hid) => (
              <span key={hid}>
                {data.hooks.find((h) => h.id === hid)?.name}
              </span>
            ))}
          </div>
        </div>
        <ContextUsage session={session} model={model} />
        <div className={cx("composer", session.archived && "disabled")}>
          {slash.list}
          <textarea
            ref={textarea}
            aria-label="Message your agent"
            role="combobox"
            aria-expanded={slash.open}
            aria-controls="slash-suggest-listbox"
            aria-autocomplete="list"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              session.archived
                ? "Restore this session to continue…"
                : "Give your agent something to work on… / for native commands"
            }
            disabled={session.archived || !!session.taskId}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-bottom">
            <span className="composer-model">
              {model?.kind === "cloud" ? (
                <Cloud size={14} />
              ) : (
                <Cpu size={14} />
              )}
              <span>{short(model)}</span>
              <span className="composer-divider" />{" "}
              <span className="subtle">
                {session.harness === "direct" ? "Chat" : "Agent"}
              </span>
            </span>
            <div className="composer-send">
              <span className="subtle">
                {inFlight ? "Session in progress" : "↵ to send"}
              </span>
              {inFlight ? (
                <button
                  className="stop-button"
                  title="Stop this turn"
                  aria-label="Stop this turn"
                  onClick={() => call("cancel", { sid: session.id })}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="Send message"
                  onClick={send}
                  disabled={
                    !draft.trim() ||
                    sending ||
                    session.archived ||
                    !!session.taskId
                  }
                >
                  {sending ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
        <footer className="composer-footnote">
          <span>
            <ShieldCheck size={12} />
            Context stays in this session
          </span>
          <span>
            {pool?.active
              ? `${pool.active}/${pool.parallel} shared slots active · throughput is shared`
              : model?.kind === "local"
                ? "One model instance · independent conversations"
                : "CLI login checked when a turn runs"}
          </span>
        </footer>
      </div>
    </section>
  );
}
function MessageView({
  message: m,
  harness,
  notify,
  openArtifact,
}: {
  message: Message;
  harness: string;
  notify: (text: string) => void;
  openArtifact: (id: string) => void;
}) {
  return (
    <article className={cx("message", m.role)}>
      <div className={cx("message-avatar", m.role)}>
        {m.role === "user" ? "You" : <Brand small />}
      </div>
      <div className="message-main">
        <div className="message-heading">
          <strong>
            {m.role === "user"
              ? "You"
              : harness === "direct"
                ? "Assistant"
                : harness === "pi"
                  ? "Pi"
                  : harness === "claude"
                    ? "Claude"
                    : harness[0].toUpperCase() + harness.slice(1)}
          </strong>
          <time>
            {new Date(m.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
          {m.role === "assistant" && m.status === "streaming" && (
            <span className="generating">
              <span />
              Working
            </span>
          )}
          <button
            className="message-copy"
            title="Copy message"
            onClick={() => {
              navigator.clipboard
                .writeText(m.content)
                .then(() => notify("Message copied"));
            }}
          >
            <Copy size={13} />
          </button>
        </div>
        {m.thinking && (
          <details className="thoughts">
            <summary>
              <Sparkles size={13} />
              Reasoning
              <ChevronDown size={12} />
            </summary>
            <div>{m.thinking}</div>
          </details>
        )}
        {m.tools && m.tools.length > 0 && (
          <details className="tool-events">
            <summary>
              <Terminal size={13} />
              {m.tools.length} tool event{m.tools.length !== 1 ? "s" : ""}
              <ChevronDown size={12} />
            </summary>
            {m.tools.map((tool, i) => (
              <div className="tool-event" key={i}>
                <strong>
                  <Code2 size={12} />
                  {tool.name}
                </strong>
                {tool.input != null && (
                  <pre>{formatTool(tool.input)?.slice(0, 16000)}</pre>
                )}
                {tool.output != null && (
                  <pre>{formatTool(tool.output)?.slice(0, 16000)}</pre>
                )}
              </div>
            ))}
          </details>
        )}
        <div className="markdown">
          {m.role === "user" ? (
            <p className="user-text">{m.content}</p>
          ) : m.content ? (
            <Markdown>{m.content}</Markdown>
          ) : m.status === "streaming" ? (
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="subtle">No answer text was generated.</span>
          )}
        </div>
        {m.artifacts?.map((artifact) => (
          <div className="artifact-card" key={artifact.id}>
            <FileText size={20} />
            <div>
              <strong>{artifact.title}</strong>
              <small>HTML + CSS · revision {artifact.revision}</small>
            </div>
            <button
              className="button"
              onClick={() => openArtifact(artifact.id)}
            >
              Open preview
            </button>
          </div>
        ))}
        {m.artifactErrors?.map((error, i) => (
          <p key={i} className="skill-warning">
            Artifact not rendered: {error}. Original source is preserved above.
          </p>
        ))}
        {m.hookSnapshot && (
          <details className="turn-instructions">
            <summary>Instructions used for this turn</summary>
            {m.hookSnapshot.map((h) => (
              <section key={h.id}>
                <strong>
                  {h.name} · v{h.revision || 1}
                </strong>
                <p>{h.content}</p>
              </section>
            ))}
          </details>
        )}
        {m.hookNames && m.hookNames.length > 0 && (
          <div className="message-instructions">
            <Sparkles size={10} />
            {m.hookNames.join(" · ")}
          </div>
        )}
        {m.role === "assistant" &&
          (m.usage || m.elapsedMs || m.status === "stopped") && (
            <div className="message-stats">
              {m.status === "stopped" && <span>Stopped</span>}
              {!!(m.turnUsage?.output || m.usage?.output) && (
                <span
                  title={`Measured output tokens${
                    m.requests && m.requests > 1
                      ? ` across ${m.requests} provider requests`
                      : ""
                  }`}
                >
                  {compact((m.turnUsage?.output || m.usage?.output) ?? 0)}{" "}
                  tokens
                  {m.requests && m.requests > 1 ? ` · ${m.requests} req` : ""}
                </span>
              )}
              {!!m.tokensPerSecond && (
                <span title="Reported output / active turn time, including prefill and tools; excludes startup and queued waits. Not engine decode speed. Live usage may lag the current request.">
                  {m.estimatedRate ? "~" : ""}
                  {m.tokensPerSecond.toFixed(1)} tok/s
                  {m.rateKind === "turn-throughput" ? " turn" : ""}
                  {m.estimatedRate ? " estimated" : ""}
                </span>
              )}
              {!!m.elapsedMs && <span>{(m.elapsedMs / 1000).toFixed(1)}s</span>}
              {m.status === "complete" && <CheckCheck size={12} />}
            </div>
          )}
      </div>
    </article>
  );
}

function SessionInspector({
  session,
  model,
  data,
  update,
}: {
  session: Session;
  model?: Model;
  data: Snapshot;
  update: (patch: Partial<Session>) => unknown;
}) {
  const pool = data.pools.find((p) => p.modelId === session.modelId);
  const last = session.messages.filter((m) => m.role === "assistant").at(-1);
  const used = last?.usage?.contextInput;
  return (
    <aside className="inspector">
      <div className="inspector-title">
        SESSION DETAILS
        <SlidersHorizontal size={13} />
      </div>
      <section>
        <div className="inspector-label">MODEL</div>
        <div className="model-detail">
          <div className="feature-icon violet">
            {model?.kind === "cloud" ? <Cloud size={17} /> : <Cpu size={17} />}
          </div>
          <div>
            <strong>{short(model)}</strong>
            <span>{model?.engine || "Compatible endpoint"}</span>
          </div>
        </div>
        <div className="detail-row">
          <span>Location</span>
          <span>{model?.kind === "local" ? "On this device" : "Cloud"}</span>
        </div>
        <div className="detail-row">
          <span>Context window</span>
          <span>{compact(model?.context || 0)}</span>
        </div>
        <div className="detail-row">
          <span>Harness</span>
          <span>{session.harness}</span>
        </div>
      </section>
      <section>
        <div className="inspector-label">SHARED INFERENCE</div>
        <div className="slots-display">
          {Array.from({ length: Math.min(pool?.parallel || 1, 16) }, (_, i) => (
            <span key={i} className={i < (pool?.active || 0) ? "occupied" : ""}>
              <Layers size={16} />
            </span>
          ))}
        </div>
        <div className="detail-row">
          <span>Active sessions</span>
          <span>
            {pool?.active || 0} / {pool?.parallel || 1}
          </span>
        </div>
        <div className="detail-row">
          <span>In queue</span>
          <span>{pool?.queued || 0}</span>
        </div>
        <p className="inspector-note">
          Sessions share model weights and compute. Each keeps its own
          conversation and context cache.
        </p>
      </section>
      <section>
        <div className="inspector-label">CONTEXT & USAGE</div>
        <div className="detail-row">
          <span>Last request context input</span>
          <span>
            {used !== undefined ? `${compact(used)} tokens` : "Unavailable"}
          </span>
        </div>
        {last?.usage?.cacheRead !== undefined && (
          <div className="detail-row">
            <span>Reported cached input</span>
            <span>{compact(last.usage.cacheRead)} tokens</span>
          </div>
        )}
        <div className="meter violet-meter">
          <span
            style={{
              width: `${Math.min(100, ((used ?? 0) / (model?.context || 1)) * 100)}%`,
            }}
          />
        </div>
        <div className="detail-row">
          <span>Conversation turns</span>
          <span>
            {session.messages.filter((m) => m.role === "user").length}
          </span>
        </div>
        <div className="detail-row">
          <span>Last reported output</span>
          <span>
            {last?.usage?.output !== undefined
              ? compact(last.usage.output)
              : "—"}
          </span>
        </div>
        {last?.turnUsage && (
          <div className="detail-row">
            <span>
              Turn total{last.requests ? ` · ${last.requests} requests` : ""}
            </span>
            <span>
              {last.turnUsage.input !== undefined
                ? compact(last.turnUsage.input)
                : "—"}{" "}
              in ·{" "}
              {last.turnUsage.output !== undefined
                ? compact(last.turnUsage.output)
                : "—"}{" "}
              out
            </span>
          </div>
        )}
        {last?.usage?.reasoning !== undefined && (
          <div className="detail-row">
            <span>Reasoning output</span>
            <span>{compact(last.usage.reasoning)} tokens</span>
          </div>
        )}
      </section>
      <section>
        <div className="inspector-label">PERMISSIONS</div>
        <label className="permission-picker">
          <ShieldCheck size={14} />
          <select
            aria-label="Session permission"
            value={session.permission}
            disabled={busy(session)}
            onChange={(e) =>
              update({ permission: e.target.value as Session["permission"] })
            }
          >
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
          </select>
        </label>
        <p className="inspector-note">
          {session.harness === "direct"
            ? "Direct chat has no file or shell tools."
            : session.permission === "read-only"
              ? "File and shell writes are restricted by the harness adapter."
              : "The agent can edit files in its workspace. Pi, Hermes, and OpenCode may also run commands."}
        </p>
      </section>
      <div className="inspector-bottom">
        <ShieldCheck size={22} />
        <strong>A continuous thread</strong>
        <p>
          Switch sessions or close the app.
          <br />
          Your conversation is saved.
        </p>
      </div>
    </aside>
  );
}

function NewSession({
  data,
  call,
  close,
  created,
}: {
  data: Snapshot;
  call: Call;
  close: () => void;
  created: (sid: string) => void;
}) {
  const eligible = data.models.filter((m) => !m.managed || m.installed);
  // Reuse the most recently active compatible model and workspace.
  const recent = [...data.sessions]
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const [mid, setMid] = useState(
    eligible.find((m) => m.id === recent?.modelId)?.id ||
      eligible.find((m) => m.kind === "local" && !m.experimental)?.id ||
      eligible[0]?.id ||
      "",
  );
  const model = data.models.find((m) => m.id === mid);
  const [harness, setHarness] = useState(model?.harness || "direct");
  const [cwd, setCwd] = useState(recent?.cwd || "");
  const [preset, setPreset] = useState("chat");
  const [thinking, setThinking] = useState<ThinkingLevel>("default");
  const [permission, setPermission] =
    useState<Session["permission"]>("read-only");
  const defaultsFor = (path: string) => {
    const w = data.settings.workspaceHooks?.[path];
    return [
      ...new Set([...data.settings.defaultHooks, ...(w?.enabled || [])]),
    ].filter((id) => !w?.disabled.includes(id));
  };
  const [hooks, setHooks] = useState(defaultsFor(cwd));
  useEffect(() => {
    setHooks([
      ...new Set([
        ...defaultsFor(cwd),
        ...(preset === "review"
          ? ["review"]
          : preset === "plan"
            ? ["plan"]
            : preset === "implement"
              ? ["local-work"]
              : []),
      ]),
    ]);
  }, [cwd, preset]);
  const [pending, setPending] = useState(false);
  const choices = data.harnesses.filter((h) =>
    model?.harness
      ? h.id === model.harness
      : model?.managed
        ? ["direct", "pi", "opencode", "hermes"].includes(h.id)
        : h.id === "direct",
  );
  return (
    <Modal
      title="A new thread of thought"
      description="Choose your model and harness. You can run another session on the same model at any time."
      close={close}
    >
      <div className="form">
        <label>
          Session preset
          <select
            aria-label="Session preset"
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setPermission(
                e.target.value === "implement"
                  ? "workspace-write"
                  : "read-only",
              );
            }}
          >
            <option value="chat">Chat</option>
            <option value="implement">Implement</option>
            <option value="review">Review</option>
            <option value="plan">Plan</option>
          </select>
        </label>

        <label>
          Model
          <select
            aria-label="Model"
            value={mid}
            onChange={(e) => {
              setMid(e.target.value);
              setHarness(
                data.models.find((m) => m.id === e.target.value)?.harness ||
                  "direct",
              );
            }}
          >
            <optgroup label="LOCAL MODELS">
              {eligible
                .filter((m) => m.kind === "local")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="CLOUD CONNECTIONS">
              {eligible
                .filter((m) => m.kind === "cloud")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <label>
          Harness
          <div className="harness-grid">
            {choices.map((h) => (
              <button
                type="button"
                key={h.id}
                className={cx("harness-choice", h.id === harness && "selected")}
                disabled={!h.available}
                onClick={() => setHarness(h.id)}
              >
                {h.id === "direct" ? (
                  <MessageSquare size={17} />
                ) : (
                  <Terminal size={17} />
                )}
                <span>
                  <strong>{h.name}</strong>
                  <small>
                    {!h.available
                      ? "Not installed"
                      : h.id === "direct"
                        ? "Conversation only"
                        : "Tools & native context"}
                  </small>
                </span>
                {h.id === harness && <Check size={14} />}
              </button>
            ))}
          </div>
        </label>
        {harness === "pi" && (
          <label>
            Thinking level
            <ThinkingSelect value={thinking} onChange={setThinking} />
          </label>
        )}
        <label>
          Workspace<span className="optional">Optional for chat</span>
          <div className="input-action">
            <input
              aria-label="Workspace path"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="Choose a project folder…"
            />
            <button
              title="Choose workspace folder"
              onClick={async () => {
                const path = await call<string>("chooseFolder");
                if (path) setCwd(path);
              }}
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </label>
        <label>
          Permissions
          <select
            aria-label="New session permissions"
            value={permission}
            onChange={(e) =>
              setPermission(e.target.value as Session["permission"])
            }
            disabled={preset === "review"}
          >
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
          </select>
        </label>
        {harness === "direct" && (
          <p className="form-note">
            Direct chat has no file or shell tools. Paste code for review, or
            select a coding harness for project access.
          </p>
        )}
        {harness === "hermes" && permission === "read-only" && (
          <p className="skill-warning">
            Hermes requires write access. Choose another harness for read-only
            work.
          </p>
        )}
        <label>
          Recurring instructions
          <span className="optional">Repeated on every message</span>
          <div className="hook-pills">
            {data.hooks.map((h) => (
              <button
                key={h.id}
                className={cx("hook-pill", hooks.includes(h.id) && "selected")}
                onClick={() =>
                  setHooks(
                    hooks.includes(h.id)
                      ? hooks.filter((id) => id !== h.id)
                      : [...hooks, h.id],
                  )
                }
              >
                {hooks.includes(h.id) ? (
                  <Check size={12} />
                ) : (
                  <Plus size={12} />
                )}{" "}
                {h.name}
              </button>
            ))}
          </div>
        </label>
        {model?.kind === "local" && (
          <div className="form-note">
            <Layers size={17} />
            <p>
              Uses one shared model runtime with up to{" "}
              <strong>
                {model.parallel} concurrent session
                {model.parallel !== 1 ? "s" : ""}
              </strong>
              . Additional sessions wait in the model queue. Adjust slots in
              Compute.
            </p>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={
            !mid ||
            pending ||
            (harness === "hermes" && permission === "read-only") ||
            !choices.find((h) => h.id === harness)?.available
          }
          onClick={async () => {
            setPending(true);
            const sid = await call<string>("create", {
              modelId: mid,
              harness,
              cwd,
              hookIds: hooks,
              preset,
              permission,
              ...(harness === "pi" ? { thinking } : {}),
            });
            setPending(false);
            if (sid) {
              created(sid);
              close();
            }
          }}
        >
          <Plus size={15} />
          Create session
        </button>
      </div>
    </Modal>
  );
}

function Compute({
  data,
  call,
  edit,
}: {
  data: Snapshot;
  call: Call;
  edit: (m: Model) => void;
}) {
  const localModels = data.models.filter(
    (m) => m.kind === "local" && (!m.managed || m.installed),
  );
  const active = data.pools.reduce((n, p) => n + p.active, 0),
    queued = data.pools.reduce((n, p) => n + p.queued, 0);
  return (
    <div className="page">
      <PageHeading
        eyebrow="BUILT TO SHARE"
        title="One model. More momentum."
        description="Manage shared inference, memory headroom, and the work waiting its turn."
        action={
          <button className="button" onClick={() => call("refresh")}>
            <Activity size={15} />
            Refresh
          </button>
        }
      />
      <div className="stat-grid">
        <Stat
          icon={<Cpu size={18} />}
          label="Available memory"
          value={`${data.memory.availableGiB.toFixed(1)}`}
          suffix="GiB"
          detail={`of ${data.memory.totalGiB.toFixed(0)} GiB system memory`}
        />
        <Stat
          icon={<Layers size={18} />}
          label="Active sessions"
          value={`${active}`}
          detail="Independent conversation contexts"
        />
        <Stat
          icon={<ListFilter size={18} />}
          label="Queued turns"
          value={`${queued}`}
          detail="Scheduled fairly across model pools"
        />
        <Stat
          icon={<ShieldCheck size={18} />}
          label="System reserve"
          value={`${data.settings.reserveGiB}`}
          suffix="GiB"
          detail="Protected from new inference work"
        />
      </div>
      <div className="runtime-banner">
        <div className="runtime-icon">
          <Radio size={21} />
        </div>
        <div>
          <strong>
            {data.runtime
              ? `Resident: ${data.runtime.profile}`
              : "No managed model is loaded"}
          </strong>
          <p>
            {data.runtime
              ? `${data.runtime.sessions} runtime slots · PID ${data.runtime.pid} · ${data.runtime.owned ? "Started by Relay" : "Started outside Relay"}`
              : "Sending a local message loads one runtime. Sessions on that profile reuse the same weights."}
          </p>
        </div>
        {data.runtime?.owned && (
          <button className="button" onClick={() => call("unload")}>
            <Unplug size={14} />
            Unload model
          </button>
        )}
      </div>
      <div className="section-heading">
        <h3>
          Local model pools <span>{localModels.length}</span>
        </h3>
        <span>Shared weights · per-session context</span>
      </div>
      <div className="pool-list">
        {localModels.map((m) => {
          const pool = data.pools.find((p) => p.modelId === m.id)!;
          return (
            <div className="pool-card" key={m.id}>
              <div className="pool-main">
                <div className="feature-icon violet">
                  <Cpu size={20} />
                </div>
                <div>
                  <h3>
                    {short(m)}
                    {m.experimental && (
                      <span className="tag amber-tag">Experimental</span>
                    )}
                  </h3>
                  <p>
                    {m.engine || m.endpoint} <span>·</span> {compact(m.context)}{" "}
                    context <span>·</span>{" "}
                    {m.estimatedGiB
                      ? `~${m.estimatedGiB} GiB base footprint`
                      : "External runtime"}
                  </p>
                </div>
                <span
                  className={cx("pool-status", pool.active > 0 && "working")}
                >
                  {pool.active ? (
                    <>
                      <span />
                      {pool.active} working
                    </>
                  ) : pool.paused ? (
                    "Paused"
                  ) : data.runtime?.profile === m.profile ? (
                    "Resident"
                  ) : (
                    "Standby"
                  )}
                </span>
              </div>
              <div className="pool-bottom">
                <div className="pool-slots">
                  {Array.from({ length: Math.min(m.parallel, 8) }, (_, i) => (
                    <span
                      className={i < pool.active ? "active-slot" : ""}
                      key={i}
                    >
                      <Layers size={12} />
                    </span>
                  ))}
                  <span>
                    {pool.active}/{pool.parallel} active
                  </span>
                  <span className="subtle">{pool.queued} queued</span>
                </div>
                <div className="pool-buttons">
                  <button
                    onClick={() =>
                      call("pause", { modelId: m.id, paused: !pool.paused })
                    }
                  >
                    {pool.paused ? <Play size={13} /> : <Pause size={13} />}{" "}
                    {pool.paused ? "Resume queue" : "Pause queue"}
                  </button>
                  <button onClick={() => edit(m)}>
                    <SlidersHorizontal size={13} />
                    Configure slots
                  </button>
                </div>
              </div>
              {pool.startupGiB !== undefined && !pool.blocked && (
                <div className="pool-note">
                  Estimated startup requirement: {pool.startupGiB.toFixed(1)}{" "}
                  GiB including system reserve.
                </div>
              )}
              {pool.blocked && <div className="pool-note">{pool.blocked}</div>}
            </div>
          );
        })}
      </div>
      <div className="compute-explanation">
        <Layers size={21} />
        <div>
          <h3>Parallel sessions share compute, not conversations.</h3>
          <p>
            More sessions can run on the same large model without loading
            another copy of its weights. Each session still needs KV cache and
            prefill headroom. Individual token rates can decrease as concurrency
            increases. Runtime capacity and available memory determine when the
            next turn starts. Native coding harnesses hold a slot for their
            whole turn, including tool work; queued peers cannot reply until a
            slot is released.
          </p>
          <span>
            {data.memory.source} · Swap in use: {data.memory.swapGiB.toFixed(1)}{" "}
            GiB
          </span>
        </div>
      </div>
      <ProcessMemory call={call} />
    </div>
  );
}
function Stat({
  icon,
  label,
  value,
  suffix,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  suffix?: string;
  detail: string;
}) {
  return (
    <div className="stat-card">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
      <p>{detail}</p>
    </div>
  );
}

function Connections({
  data,
  call,
  edit,
}: {
  data: Snapshot;
  call: Call;
  edit: (m: Model) => void;
}) {
  return (
    <div className="page">
      <PageHeading
        eyebrow="YOUR MODELS. YOUR CHOICE."
        title="A well-connected workspace."
        description="Use the harnesses you already trust, with local inference and your cloud accounts."
        action={
          <button className="button" onClick={() => call("refresh")}>
            <Activity size={15} />
            Detect again
          </button>
        }
      />
      <div className="section-heading">
        <h3>Agent harnesses</h3>
        <span>Existing CLI installations</span>
      </div>
      <div className="connection-grid">
        {data.harnesses
          .filter((h) => h.id !== "direct")
          .map((h) => (
            <div className="connection-card" key={h.id}>
              <div className="connection-top">
                <div
                  className={cx(
                    "connection-logo",
                    ["codex", "claude"].includes(h.id) ? "cloud-logo" : "",
                  )}
                >
                  {h.id === "codex" ? (
                    <Code2 size={27} />
                  ) : h.id === "claude" ? (
                    <Sparkles size={27} />
                  ) : (
                    <Terminal size={24} />
                  )}
                </div>
                <span
                  className={cx("connection-status", h.available && "detected")}
                >
                  <span />
                  {h.available ? "CLI detected" : "Not installed"}
                </span>
              </div>
              <h3>{h.name}</h3>
              <p>{h.detail}</p>
              {["codex", "claude"].includes(h.id) && (
                <button
                  className="text-button cloud-config"
                  onClick={() => {
                    const m = data.models.find((m) => m.harness === h.id);
                    if (m) edit(m);
                  }}
                >
                  Configure model
                  <ArrowUpRight size={12} />
                </button>
              )}
              <footer>
                {["codex", "claude"].includes(h.id)
                  ? "Sign in using the provider’s CLI. Authentication is checked when a turn runs."
                  : "Uses your LocalAi model configuration. Native session identifiers are saved automatically."}
              </footer>
            </div>
          ))}
      </div>
      <div className="section-heading">
        <h3>Compatible endpoints</h3>
        <button
          className="text-button"
          onClick={() =>
            edit({
              id: `endpoint:${crypto.randomUUID()}`,
              name: "",
              kind: "local",
              model: "",
              endpoint: "http://127.0.0.1:11434/v1",
              context: 32768,
              parallel: 2,
              slotGiB: 4,
            })
          }
        >
          <Plus size={14} />
          Add endpoint
        </button>
      </div>
      <div className="endpoint-list">
        {data.models
          .filter((m) => !m.managed && !m.harness)
          .map((m) => (
            <button className="endpoint-row" key={m.id} onClick={() => edit(m)}>
              <div className="feature-icon green">
                <Unplug size={19} />
              </div>
              <div>
                <strong>{m.name}</strong>
                <span>{m.endpoint}</span>
              </div>
              <span className="tag">{m.parallel} slots</span>
              <ChevronRight size={15} />
            </button>
          ))}
      </div>
      <div className="form-note endpoint-note">
        <Box size={19} />
        <p>
          Add an OpenAI-compatible endpoint from Ollama, llama.cpp, LM Studio,
          or another server. Run the server separately; Relay manages
          conversation scheduling and context. Remote endpoints use HTTPS and
          keys stay in the OS keyring.
        </p>
      </div>
      <div className="section-heading">
        <h3>LocalAi integration</h3>
        <span>
          {data.models.filter((m) => m.managed).length} profiles discovered
        </span>
      </div>
      <div className="integration-row">
        <Folder size={20} />
        <div>
          <strong>Shared model store & runtime controller</strong>
          <span>
            {data.settings.localaiRoot ||
              "Set your LocalAi repository path in Settings"}
          </span>
        </div>
        <ShieldCheck size={19} />
      </div>
    </div>
  );
}

function SettingsPage({
  data,
  call,
  save,
}: {
  data: Snapshot;
  call: Call;
  save: (p: Partial<Settings>) => unknown;
}) {
  const [root, setRoot] = useState(data.settings.localaiRoot);
  return (
    <div className="page settings-page">
      <PageHeading
        eyebrow="JUST THE WAY YOU WORK"
        title="Workspace settings."
        description="A few sensible controls for your agents and your machine."
      />
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="setting-row">
          <div>
            <strong>Color theme</strong>
            <p>A quieter workspace, day or night.</p>
          </div>
          <div className="segmented">
            <button
              className={cx(data.settings.theme === "dark" && "active")}
              onClick={() => save({ theme: "dark" })}
            >
              <Moon size={14} />
              Dark
            </button>
            <button
              className={cx(data.settings.theme === "light" && "active")}
              onClick={() => save({ theme: "light" })}
            >
              <Sun size={14} />
              Light
            </button>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>Scheduling</h3>
        <div className="setting-row">
          <div>
            <strong>System memory reserve</strong>
            <p>New local turns wait when they would use this headroom.</p>
          </div>
          <label className="number-unit">
            <input
              aria-label="Memory reserve"
              type="number"
              min={2}
              max={128}
              value={data.settings.reserveGiB}
              onChange={(e) => {
                const n = +e.target.value;
                if (n >= 2 && n <= 128) save({ reserveGiB: n });
              }}
            />
            GiB
          </label>
        </div>
        <div className="setting-row">
          <div>
            <strong>Cloud concurrency per provider</strong>
            <p>Separate from local model slots and device memory.</p>
          </div>
          <label className="number-unit">
            <input
              aria-label="Cloud concurrency"
              type="number"
              min={1}
              max={16}
              value={data.settings.cloudParallel}
              onChange={(e) => {
                const n = +e.target.value;
                if (n >= 1 && n <= 16) save({ cloudParallel: n });
              }}
            />
            turns
          </label>
        </div>
      </section>
      <section className="settings-section">
        <h3>LocalAi integration</h3>
        <label className="setting-field">
          Repository path
          <div className="input-action">
            <input
              aria-label="LocalAi repository path"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
            />
            <button
              title="Choose LocalAi folder"
              onClick={async () => {
                const p = await call<string>("chooseFolder");
                if (p) setRoot(p);
              }}
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </label>
        <button
          className="button"
          onClick={async () => {
            await save({ localaiRoot: root });
            call("refresh");
          }}
        >
          <Check size={14} />
          Save & detect profiles
        </button>
      </section>
      <section className="settings-section">
        <h3>Local data</h3>
        <div className="setting-row">
          <div>
            <strong>Conversations, context, and runtime logs</strong>
            <p>Saved locally with atomic writes and a recovery backup.</p>
          </div>
          <button className="button" onClick={() => call("openData")}>
            <FolderOpen size={14} />
            Open data folder
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Credentials</strong>
            <p>
              Cloud harnesses use their own CLI login. Endpoint API keys use
              your OS keyring.
            </p>
          </div>
          <ShieldCheck size={19} />
        </div>
      </section>
      <footer className="settings-footer">
        <Brand small />
        <span>Relay 0.1.0</span>
        <span>A little more room to think.</span>
      </footer>
    </div>
  );
}

function HandoffDialog({
  session,
  call,
  close,
  created,
}: {
  session: Session;
  call: Call;
  close: () => void;
  created: (sid: string) => void;
}) {
  const [summary, setSummary] = useState("");
  return (
    <Modal
      title="Continue with a context handoff"
      description="Write a short handoff with the goal, decisions, and next steps. A fresh session keeps this summary as its starting context. Your original conversation stays saved."
      close={close}
    >
      <div className="form">
        <label>
          Handoff summary
          <textarea
            className="instruction-input"
            aria-label="Handoff summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Goal, important decisions, completed work, and what to do next…"
          />
        </label>
      </div>
      <div className="modal-footer">
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!summary.trim()}
          onClick={async () => {
            const sid = await call<string>("handoff", {
              sid: session.id,
              summary,
            });
            if (sid) {
              created(sid);
              close();
            }
          }}
        >
          <ArrowRight size={15} />
          Create fresh session
        </button>
      </div>
    </Modal>
  );
}

function HookEditor({
  hook,
  call,
  close,
}: {
  hook: Hook;
  call: Call;
  close: () => void;
}) {
  const [value, setValue] = useState(hook);
  return (
    <Modal
      title={hook.name ? "Edit instruction" : "New instruction"}
      description="Included as text on every user turn while selected in a session."
      close={close}
    >
      <div className="form">
        <label>
          Name
          <input
            aria-label="Instruction name"
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
            placeholder="e.g. Review before changing"
          />
        </label>
        <label>
          Short description
          <input
            value={value.description}
            onChange={(e) =>
              setValue({ ...value, description: e.target.value })
            }
            placeholder="What should this help with?"
          />
        </label>
        <label>
          Instructions
          <textarea
            className="instruction-input"
            aria-label="Instruction content"
            value={value.content}
            onChange={(e) => setValue({ ...value, content: e.target.value })}
            placeholder="Describe how your agent should work…"
          />
        </label>
        <label>
          Category
          <select
            value={value.category || "workflow"}
            onChange={(e) =>
              setValue({
                ...value,
                category: e.target.value as Hook["category"],
              })
            }
          >
            <option value="workflow">Task skill</option>
            <option value="style">Response preference</option>
            <option value="output">Output skill</option>
          </select>
        </label>
        {value.warnings?.map((w) => (
          <p className="skill-warning" key={w}>
            {w}
          </p>
        ))}
        {(value.origin === "bundled" || value.bundledId) && (
          <details>
            <summary>Bundled skill</summary>
            <p>
              Edits create a personal override. The packaged original remains
              available.
            </p>
            <button
              className="button"
              onClick={async () => {
                if (await call("resetSkill", { id: value.id })) close();
              }}
            >
              Restore bundled original
            </button>
          </details>
        )}
        {value.source && (
          <p className="source-note">
            Imported from {value.source}. Saved as a copy.
          </p>
        )}
      </div>
      <div className="modal-footer">
        {hook.name && (
          <button
            className="button"
            onClick={() => call("exportSkill", { id: hook.id })}
          >
            Export SKILL.md
          </button>
        )}
        {hook.name && (
          <button
            className="text-button danger"
            onClick={async () => {
              await call("deleteHook", { id: hook.id });
              close();
            }}
          >
            Remove
          </button>
        )}
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!value.name.trim() || !value.content.trim()}
          onClick={async () => {
            if (
              await call("saveHook", {
                hook: {
                  id: value.id,
                  name: value.name,
                  description: value.description,
                  content: value.content,
                  source: value.source,
                  category: value.category,
                },
              })
            )
              close();
          }}
        >
          <Check size={15} />
          Save instruction
        </button>
      </div>
    </Modal>
  );
}
function ModelEditor({
  model,
  call,
  close,
}: {
  model: Model;
  call: Call;
  close: () => void;
}) {
  const [value, setValue] = useState(model);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      title={
        model.managed
          ? "Shared model capacity"
          : model.harness
            ? "Cloud model settings"
            : "Compatible endpoint"
      }
      description={
        model.managed
          ? "One set of weights. A separate context for each concurrent session."
          : "Connect a model using your CLI defaults or an OpenAI-compatible API."
      }
      close={close}
    >
      <div className="form">
        <label>
          Display name
          <input
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
          />
        </label>
        {!model.managed && (
          <label>
            Model identifier
            <input
              aria-label="Model identifier"
              value={value.model}
              onChange={(e) => setValue({ ...value, model: e.target.value })}
              placeholder={
                model.harness
                  ? "Leave blank to use the CLI default"
                  : "Model ID from your server"
              }
            />
          </label>
        )}
        {!model.managed && !model.harness && (
          <>
            <label>
              Endpoint URL
              <input
                aria-label="Endpoint URL"
                value={value.endpoint}
                onChange={(e) =>
                  setValue({ ...value, endpoint: e.target.value })
                }
              />
            </label>
            <label>
              Location
              <select
                value={value.kind}
                onChange={(e) =>
                  setValue({
                    ...value,
                    kind: e.target.value as Model["kind"],
                    slotGiB: e.target.value === "local" ? 4 : 0,
                  })
                }
              >
                <option value="local">
                  Local · apply hardware memory limits
                </option>
                <option value="cloud">Remote · cloud concurrency limits</option>
              </select>
            </label>
            <label>
              API key
              <span className="optional">Optional · stored in OS keyring</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Leave blank to keep existing credentials"
              />
            </label>
          </>
        )}
        <div className="form-columns">
          <label>
            Concurrent slots
            <input
              aria-label="Concurrent slots"
              type="number"
              min={1}
              max={16}
              value={value.parallel}
              onChange={(e) =>
                setValue({ ...value, parallel: +e.target.value })
              }
            />
          </label>
          <label>
            Context window
            <input
              aria-label="Context window"
              disabled={model.managed}
              type="number"
              min={4096}
              max={2000000}
              value={value.context}
              onChange={(e) => setValue({ ...value, context: +e.target.value })}
            />
          </label>
        </div>
        {value.kind === "local" && (
          <label>
            Additional KV / prefill headroom per active session (GiB)
            <input
              aria-label="Memory per slot"
              type="number"
              min={0.25}
              max={128}
              step={0.25}
              value={value.slotGiB}
              onChange={(e) => setValue({ ...value, slotGiB: +e.target.value })}
            />
          </label>
        )}
        <div className="form-note">
          <Cpu size={18} />
          <p>
            {model.managed
              ? "Changes apply the next time Relay loads this profile. An already running server keeps its actual slot limit until unloaded. Long contexts need more KV memory; increase the per-slot budget to match your workload. These estimates are admission controls, not measured peak guarantees."
              : model.harness
                ? "Cloud turns use the per-provider concurrency limit in Settings. No local model memory is reserved."
                : "Relay shares this server across sessions. Configure the server itself with at least as many slots. Each request sends its own conversation history."}
          </p>
        </div>
      </div>
      <div className="modal-footer">
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={
            saving ||
            !value.name.trim() ||
            value.parallel < 1 ||
            value.parallel > 16
          }
          onClick={async () => {
            setSaving(true);
            const clean = {
              id: value.id,
              name: value.name,
              kind: value.kind,
              model: value.model,
              ...(value.endpoint ? { endpoint: value.endpoint } : {}),
              context: value.context,
              parallel: value.parallel,
              slotGiB: value.slotGiB,
              description: value.description || "",
            };
            if (
              await call("saveModel", {
                model: clean,
                ...(apiKey ? { apiKey } : {}),
              })
            )
              close();
            setSaving(false);
          }}
        >
          <Check size={15} />
          Save configuration
        </button>
      </div>
    </Modal>
  );
}
function CommandPalette({
  sessions,
  open,
  close,
  create,
  go,
}: {
  sessions: Session[];
  open: (sid: string) => void;
  close: () => void;
  create: () => void;
  go: (view: View) => void;
}) {
  const [search, setSearch] = useState("");
  return (
    <Modal title="Jump to anything" close={close}>
      <div className="palette-search">
        <Search size={18} />
        <input
          aria-label="Search commands"
          placeholder="Find a session or command…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>ESC</kbd>
      </div>
      <div className="palette-results">
        {[
          ["New session", create, Plus],
          ["Compute", () => go("compute"), Cpu],
          ["Connections", () => go("connections"), Unplug],
          ["Instructions & skills", () => go("library"), Sparkles],
          ["Settings", () => go("settings"), Settings2],
        ]
          .filter(([label]) =>
            String(label).toLowerCase().includes(search.toLowerCase()),
          )
          .map(([label, action, Icon]) => {
            const I = Icon as typeof Plus;
            return (
              <button key={String(label)} onClick={action as () => void}>
                <I size={16} />
                {String(label)}
                <ArrowRight size={14} />
              </button>
            );
          })}
        {sessions
          .filter(
            (s) =>
              !s.archived &&
              s.title.toLowerCase().includes(search.toLowerCase()),
          )
          .slice(0, 12)
          .map((s) => (
            <button key={s.id} onClick={() => open(s.id)}>
              <MessageSquare size={16} />
              {s.title}
              <span className="subtle">{s.status}</span>
            </button>
          ))}
      </div>
    </Modal>
  );
}

// Pi's --thinking level. "Default" passes no flag, so the harness decides.
function ThinkingSelect({
  value,
  onChange,
  disabled,
}: {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label="Thinking level"
      title="Pi reasoning level for the next turn"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ThinkingLevel)}
    >
      {THINKING_LEVELS.map((level) => (
        <option key={level} value={level}>
          {level === "default"
            ? "Thinking: Default"
            : `Thinking: ${level[0].toUpperCase()}${level.slice(1)}`}
        </option>
      ))}
    </select>
  );
}
