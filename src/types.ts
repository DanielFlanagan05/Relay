export const THINKING_LEVELS = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type AgentTask = {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  objective: string;
  context: string;
  scope: string;
  expectedResult: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadline: number;
  maxSeconds: number;
  result: string;
  error: string;
  truncated?: boolean;
  automated: boolean;
};
export type Artifact = {
  id: string;
  sessionId: string;
  messageId: string;
  title: string;
  revision: number;
  createdAt: string;
  warnings: string[];
};
export type ArtifactContent = Artifact & {
  source: {
    version: number;
    type: string;
    title: string;
    html: string;
    css: string;
  };
  html: string;
  css: string;
  document: string;
};
export type Hook = {
  id: string;
  name: string;
  description: string;
  content: string;
  source?: string;
  revision?: number;
  category?: "style" | "workflow" | "output";
  origin?: "bundled" | "user" | "imported";
  contentHash?: string;
  requires?: string[];
  warnings?: string[];
  bundledId?: string;
  scope?: string;
};
export type Model = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  managed?: boolean;
  installed?: boolean;
  experimental?: boolean;
  model: string;
  profile?: string;
  engine?: string;
  harness?: string;
  endpoint?: string;
  context: number;
  parallel: number;
  slotGiB: number;
  estimatedGiB?: number;
  baselineParallel?: number;
  description?: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status?: string;
  thinking?: string;
  tools?: {
    name: string;
    input?: unknown;
    output?: unknown;
    status?: string;
    at: string;
  }[];
  hookNames?: string[];
  hookSnapshot?: Hook[];
  instructionWarnings?: string[];
  artifacts?: Artifact[];
  artifactErrors?: string[];
  // Fields are present only when the provider/harness actually reported
  // them; absence means unavailable, never zero.
  usage?: {
    contextInput?: number;
    scope?: "request" | "turn";
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  // Cumulative measured usage across every provider request in this turn
  // (delegation rounds included). Not context occupancy: use usage.contextInput when available.
  turnUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  requests?: number;
  usageReports?: number;
  activeMs?: number;
  rateKind?: "turn-throughput";
  tokensPerSecond?: number;
  estimatedRate?: boolean;
  elapsedMs?: number;
};
export type Session = {
  id: string;
  title: string;
  modelId: string;
  harness: string;
  cwd: string;
  status: string;
  queueReason?: string;
  error?: string;
  permission: "read-only" | "workspace-write";
  messages: Message[];
  hookIds: string[];
  nextTurnHookIds: string[];
  disabledNextTurnHookIds: string[];
  outputFormat: "auto" | "markdown" | "html";
  preset?: string;
  // Pi only. Absent or "default" passes no --thinking flag.
  thinking?: ThinkingLevel;
  taskId?: string;
  // Experimental, per-session opt-in for tool-driven delegation (Direct chat only).
  // The backend gate rejects every other route, so this is never an implied capability.
  delegation?: boolean;
  // Written only from an explicit, verifiable harness compaction event (Pi's
  // compaction_start/compaction_end); a token-count decrease alone is never
  // treated as proof of compaction. Absence means "no confirmed compaction".
  compaction?: { status: "running" | "done" | "failed"; at: string };
  // Native slash-command outcomes (phase 2). Recorded separately from chat
  // messages — a command result is never model output — and never replayed
  // after an app restart. Newest last, bounded by the backend.
  commandLog?: {
    command: string;
    status: string; // "ok" | "failed" (unknown values render generically)
    at: string;
    reason?: string;
    summary?: string;
  }[];
  pinned: boolean;
  archived: boolean;
  parentId?: string;
  updatedAt: string;
  draft: string;
  draftRevision?: number;
};
export type Settings = {
  reserveGiB: number;
  cloudParallel: number;
  defaultHooks: string[];
  workspaceHooks?: Record<string, { enabled: string[]; disabled: string[] }>;
  localaiRoot: string;
  theme: "dark" | "light";
};
export type Pool = {
  modelId: string;
  key: string;
  parallel: number;
  active: number;
  queued: number;
  paused: boolean;
  blocked?: string;
  startupGiB?: number;
};
export type Snapshot = {
  sessions: Session[];
  tasks: AgentTask[];
  // Already present in the snapshot payload; typed here so the status UI can tell
  // "queued for a slot" apart from "waiting for delegated children".
  delegations?: import("./features/status/sessionStatus").DelegationRound[];
  models: Model[];
  hooks: Hook[];
  settings: Settings;
  memory: {
    totalGiB: number;
    availableGiB: number;
    swapGiB: number;
    source: string;
  };
  harnesses: { id: string; name: string; detail: string; available: boolean }[];
  pools: Pool[];
  runtime: {
    profile: string;
    pid: number;
    sessions: number;
    owned: boolean;
  } | null;
};
// Measured per-process memory from the backend collector. `available: false` means
// the metric could not be measured; it never means "no processes".
export type ProcessSample = {
  pid: number;
  name: string;
  uid: number | null;
  own: boolean;
  rss: number | null;
  memoryReason?: string;
  relay?: boolean;
};
export type ProcessTelemetry = {
  available: boolean;
  metric: string;
  metricLabel: string;
  collectedAt: string;
  system: {
    totalGiB: number;
    availableGiB: number;
    swapGiB: number;
    source: string;
  } | null;
  processes: ProcessSample[];
  errors: string[];
  permissionLimited: boolean;
  truncated: boolean;
  skipped: number;
};
declare global {
  interface Window {
    relay: {
      call: <T = unknown>(name: string, input?: unknown) => Promise<T>;
      subscribe: (callback: (data: Snapshot) => void) => () => void;
    };
  }
}
