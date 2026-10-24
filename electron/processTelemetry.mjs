// System-wide per-process memory telemetry for the Local compute page.
//
// Design rules (from the improvement plan):
// - Measure, never estimate. Every value comes from the operating system.
// - Never report a permission-limited or unsupported measurement as zero or as an
//   empty list: the caller gets an explicit `available` flag plus reason strings.
// - Only display data crosses IPC. No paths, no credentials, no command lines.
// - The filesystem is injected so tests can point at a fixture process tree.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { memory } from "./discovery.mjs";

export const KiB = 1024;
export const GiB = 1024 ** 3;

export const RSS_METRIC = "RSS";
export const RSS_METRIC_LABEL =
  "Resident set size (RSS) measured from /proc. Shared pages are counted in every process that maps them, so the bars do not add up to memory used.";

const MAX_ERRORS = 6;
let pageBytes;
function systemPageSize() {
  if (pageBytes !== undefined) return pageBytes;
  try {
    const n = Number(
      execFileSync("getconf", ["PAGESIZE"], {
        encoding: "utf8",
        timeout: 1000,
      }),
    );
    pageBytes = Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    pageBytes = null;
  }
  return pageBytes;
}

const pushLimited = (list, message) => {
  if (!list.includes(message) && list.length < MAX_ERRORS) list.push(message);
};

function parseStatus(raw) {
  const field = (name) =>
    raw.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const name = field("Name") || "";
  const state = field("State") || "";
  const uid = Number(field("Uid")?.split(/\s+/)[0]);
  const rssKb = Number(field("VmRSS")?.match(/^(\d+)\s+kB$/)?.[1]);
  return {
    name,
    state,
    uid: Number.isFinite(uid) ? uid : null,
    rss: Number.isFinite(rssKb) && rssKb >= 0 ? rssKb * KiB : null,
  };
}

// Last-resort fallback for kernels/configurations without VmRSS in `status`.
function readStatmRss(readFile, path, pageSize) {
  try {
    if (!pageSize) return null;
    const resident = Number(readFile(path).trim().split(/\s+/)[1]);
    return Number.isFinite(resident) && resident >= 0
      ? resident * pageSize
      : null;
  } catch {
    return null;
  }
}

export function collectProcesses({
  platform = process.platform,
  procRoot = "/proc",
  readdir = (path) => readdirSync(path, { withFileTypes: true }),
  readFile = (path) => readFileSync(path, "utf8"),
  systemMemory = memory,
  ownUid = typeof process.getuid === "function" ? process.getuid() : null,
  selfPid = process.pid,
  collectedAt = () => new Date().toISOString(),
  maxEntries = Infinity,
  pageSize = platform === "linux" ? systemPageSize() : null,
} = {}) {
  let system = null;
  try {
    system = systemMemory();
  } catch {
    system = null;
  }
  const base = {
    metric: RSS_METRIC,
    metricLabel: RSS_METRIC_LABEL,
    collectedAt: collectedAt(),
    system,
    processes: [],
    errors: [],
    permissionLimited: false,
    truncated: false,
    skipped: 0,
  };

  if (platform !== "linux") {
    return {
      ...base,
      available: false,
      errors: [
        `Per-process memory measurement is only implemented for Linux; ${platform} would show estimates, so nothing is listed.`,
      ],
    };
  }

  let entries;
  try {
    entries = readdir(procRoot);
  } catch (error) {
    const limited = ["EACCES", "EPERM", "ELOOP"].includes(error?.code);
    return {
      ...base,
      available: false,
      permissionLimited: limited,
      errors: [
        limited
          ? `The process list at ${procRoot} is not readable without elevated privileges.`
          : `Process collection failed: ${error?.message || "unknown error"}`,
      ],
    };
  }

  const processes = [];
  const errors = base.errors;
  const pids = [];
  for (const entry of entries) {
    // Accept plain names or fs.Dirent-like entries so mocks stay simple.
    const label = typeof entry === "string" ? entry : entry?.name;
    if (!/^\d+$/.test(label || "")) continue;
    if (typeof entry !== "string" && entry.isDirectory?.() === false) continue;
    pids.push(Number(label));
  }

  for (const pid of pids) {
    const statusPath = `${procRoot}/${pid}/status`;
    let parsed;
    try {
      parsed = parseStatus(readFile(statusPath));
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error?.code)) {
        // The process exited between listing and reading; not an error state.
        base.skipped += 1;
        continue;
      }
      if (["EACCES", "EPERM"].includes(error?.code)) {
        base.permissionLimited = true;
        pushLimited(errors, `Permission denied measuring PID ${pid}.`);
      } else {
        pushLimited(
          errors,
          `PID ${pid} could not be read: ${error?.message || "unknown error"}`,
        );
      }
      processes.push({
        pid,
        name: `[${pid}]`,
        uid: null,
        own: false,
        rss: null,
        memoryReason: "Measurement unavailable: process could not be read",
      });
      continue;
    }
    if (parsed.state.startsWith("Z")) {
      base.skipped += 1;
      continue; // Defunct processes hold no resident memory.
    }
    let rss = parsed.rss;
    let name = parsed.name;
    if (!name) {
      try {
        name = readFile(`${procRoot}/${pid}/comm`).trim();
      } catch {
        name = "";
      }
    }
    if (rss === null)
      rss = readStatmRss(readFile, `${procRoot}/${pid}/statm`, pageSize);
    if (rss === null) {
      // Kernel threads have no resident address space; they are neither an error
      // nor a user application, so they are counted separately and stay unlisted.
      let kernelThread = false;
      try {
        kernelThread = readFile(`${procRoot}/${pid}/cmdline`).trim() === "";
      } catch {}
      if (!kernelThread) {
        pushLimited(errors, `Resident memory is unavailable for PID ${pid}.`);
      }
      if (kernelThread) {
        base.skipped += 1;
        continue;
      }
    }
    processes.push({
      pid,
      name: name || `[${pid}]`,
      uid: parsed.uid,
      own: ownUid === null ? false : parsed.uid === ownUid,
      rss,
      ...(rss === null ? { memoryReason: "Resident memory unavailable" } : {}),
      relay: pid === selfPid,
    });
  }

  // Descending by measured memory; PID as a deterministic tie-breaker.
  processes.sort((a, b) => (b.rss ?? -1) - (a.rss ?? -1) || a.pid - b.pid);
  const truncated = processes.length > maxEntries;
  return {
    ...base,
    available: true,
    processes: truncated ? processes.slice(0, maxEntries) : processes,
    truncated,
    errors,
  };
}
