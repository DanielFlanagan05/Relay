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
  usage?: { input: number; output: number };
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
  taskId?: string;
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
};
export type Snapshot = {
  sessions: Session[];
  tasks: AgentTask[];
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
declare global {
  interface Window {
    relay: {
      call: <T = unknown>(name: string, input?: unknown) => Promise<T>;
      subscribe: (callback: (data: Snapshot) => void) => () => void;
    };
  }
}
