// Renderer-local helpers for the Local compute process-memory graph.
// Pure functions over measured telemetry only: no fetching, no estimation.

export type ProcessRow = {
  pid: number;
  name: string;
  uid: number | null;
  own: boolean;
  rss: number | null;
  memoryReason?: string;
  relay?: boolean;
};

export type ProcessSampleLike = {
  available: boolean;
  collectedAt: string;
  processes: ProcessRow[];
  errors?: string[];
  permissionLimited?: boolean;
  truncated?: boolean;
};

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Human memory label. Below 1 GiB the value is more useful in MiB. */
export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MiB";
  if (bytes < GiB)
    return `${(bytes / MiB).toLocaleString(undefined, { maximumFractionDigits: 0 })} MiB`;
  return `${(bytes / GiB).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}

/** Bar width as a percentage of the largest measured process. */
export function barPercent(rss: number | null, max: number): number {
  if (
    rss === null ||
    !Number.isFinite(rss) ||
    rss <= 0 ||
    !Number.isFinite(max) ||
    max <= 0
  )
    return 0;
  // Keep non-zero processes visible without overstating tiny ones.
  return Math.min(100, (rss / max) * 100);
}

/** Name substring or PID match. Empty query returns every row. */
export function filterProcesses<T extends { pid: number; name: string }>(
  rows: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const digits = /^\d+$/.test(q);
  return rows.filter((r) =>
    digits
      ? String(r.pid).startsWith(q) || r.name.toLowerCase().includes(q)
      : r.name.toLowerCase().includes(q),
  );
}

export type SortKey = "memory" | "name" | "pid";

/** Default and only guaranteed order is measured memory, descending. */
export function sortProcesses<T extends ProcessRow>(
  rows: T[],
  key: SortKey,
): T[] {
  const copy = [...rows];
  if (key === "name")
    return copy.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  if (key === "pid") return copy.sort((a, b) => a.pid - b.pid);
  return copy.sort((a, b) => (b.rss ?? -1) - (a.rss ?? -1) || a.pid - b.pid);
}

export function summarize(rows: ProcessRow[]) {
  let total = 0,
    own = 0,
    other = 0;
  for (const r of rows) {
    if (r.rss === null || !Number.isFinite(r.rss) || r.rss <= 0) continue;
    total += r.rss;
    if (r.own) own += r.rss;
    else other += r.rss;
  }
  return { total, own, other, count: rows.length };
}

/** A sample is stale when it is older than the refresh budget by `now`. */
export function isStale(
  collectedAt: string,
  now: number,
  maxAgeMs = 20_000,
): boolean {
  const at = Date.parse(collectedAt);
  return !Number.isFinite(at) || now - at > maxAgeMs;
}

/** Processes that appeared or disappeared between two collected samples. */
export function diffSamples(
  previous: ProcessSampleLike | null,
  next: ProcessSampleLike,
): { started: number[]; exited: number[] } {
  if (!previous?.available || !next.available)
    return { started: [], exited: [] };
  const before = new Set(previous.processes.map((p) => p.pid));
  const after = new Set(next.processes.map((p) => p.pid));
  return {
    started: [...after].filter((pid) => !before.has(pid)),
    exited: [...before].filter((pid) => !after.has(pid)),
  };
}

/**
 * One honest sentence about the collection state. Unavailable and
 * permission-limited are never presented as "no processes".
 */
export function collectionNotice(
  sample: ProcessSampleLike | null,
  error: string,
): { tone: "ok" | "warn" | "error"; text: string } {
  if (error)
    return { tone: "error", text: `Memory collection failed: ${error}` };
  if (!sample) return { tone: "warn", text: "Reading process memory…" };
  if (!sample.available)
    return {
      tone: "error",
      text:
        sample.errors?.[0] ||
        "Per-process memory is unavailable on this system. No values are shown rather than estimates.",
    };
  if (sample.permissionLimited)
    return {
      tone: "warn",
      text: "Some processes are owned by other users or the system and cannot be measured without elevated privileges; unavailable measurements are labelled, not counted as zero.",
    };
  if (sample.truncated)
    return {
      tone: "warn",
      text: "The process list is longer than the display limit, so the largest processes are shown.",
    };
  if (sample.errors?.length)
    return { tone: "warn", text: sample.errors.join(" ") };
  return { tone: "ok", text: "" };
}
