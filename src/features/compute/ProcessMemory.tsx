import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Search } from "lucide-react";
import type { ProcessSample, ProcessTelemetry } from "../../types";
import {
  barPercent,
  collectionNotice,
  diffSamples,
  filterProcesses,
  formatMemory,
  isStale,
  sortProcesses,
  summarize,
  type SortKey,
} from "./processMemoryLogic";

type Call = <T = unknown>(
  name: string,
  input?: unknown,
) => Promise<T | undefined>;

// Bounded refresh: only while this page is mounted and the window is visible.
const REFRESH_MS = 5000;
const STALE_MS = 20_000;
// Rendering cap only; search still filters the complete measured list.
const PAGE_SIZE = 200;

const SORT_LABEL: Record<SortKey, string> = {
  memory: "Memory (high to low)",
  name: "Name (A–Z)",
  pid: "PID (low to high)",
};

export function ProcessMemory({
  call,
  initialSample = null,
}: {
  call: Call;
  // Optional fixture for isolated renderer tests; the app never passes it.
  initialSample?: ProcessTelemetry | null;
}) {
  const [sample, setSample] = useState<ProcessTelemetry | null>(initialSample);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("memory");
  const [changed, setChanged] = useState({ started: 0, exited: 0 });
  const previous = useRef<ProcessTelemetry | null>(initialSample);
  // A failing collector must not toast on every tick: auto-refresh pauses and the
  // page keeps the last sample plus the reason until the user presses Refresh.
  const paused = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const callRef = useRef(call);
  callRef.current = call;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [now, setNow] = useState(Date.now());
  useEffect(() => setVisibleCount(PAGE_SIZE), [query, sort]);

  const load = useCallback(async () => {
    if (inFlight.current || document.hidden) return;
    inFlight.current = true;
    paused.current = false;
    try {
      const next = await callRef.current<ProcessTelemetry>("processes");
      if (!mounted.current) return;
      if (!next || !Array.isArray(next.processes)) {
        paused.current = true;
        setError(
          "Process memory collection is not responding. Nothing is listed rather than estimated.",
        );
        return;
      }
      const delta = diffSamples(previous.current, next);
      previous.current = next;
      setSample(next);
      setError("");
      setChanged({
        started: delta.started.length,
        exited: delta.exited.length,
      });
    } catch (cause) {
      paused.current = true;
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: number | undefined;
    load();
    timer = window.setInterval(() => {
      setNow(Date.now());
      if (!document.hidden && !paused.current) load();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden && !paused.current) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      if (timer !== undefined) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const rows = useMemo(
    () => sortProcesses(filterProcesses(sample?.processes || [], query), sort),
    [sample, query, sort],
  );
  const all = useMemo(() => summarize(sample?.processes || []), [sample]);
  const peak = Math.max(1, ...(sample?.processes || []).map((p) => p.rss ?? 0));
  const notice = collectionNotice(sample, error);
  const stale = sample?.available
    ? isStale(sample.collectedAt, now, STALE_MS)
    : false;
  const system = sample?.system;

  return (
    <section className="proc-panel" aria-labelledby="proc-heading">
      <div className="section-heading">
        <h3 id="proc-heading">
          Process memory <span>{sample?.available ? all.count : ""}</span>
        </h3>
        <span>Resident memory · measured by the operating system</span>
      </div>
      <div className="proc-toolbar">
        <div className="proc-headings">
          {system ? (
            <>
              <span>
                <strong>{system.totalGiB.toFixed(0)}</strong> GiB total
              </span>
              <span>
                <strong>
                  {Math.max(0, system.totalGiB - system.availableGiB).toFixed(
                    1,
                  )}
                </strong>{" "}
                GiB used
              </span>
              <span>
                <strong>{system.availableGiB.toFixed(1)}</strong> GiB available
              </span>
            </>
          ) : (
            <span>System memory totals unavailable</span>
          )}
        </div>
        <label className="proc-search">
          <Search size={13} aria-hidden />
          <span className="proc-hidden">Search process name or PID</span>
          <input
            value={query}
            placeholder="Name or PID"
            aria-label="Search process by name or PID"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          value={sort}
          aria-label="Sort processes"
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABEL[key]}
            </option>
          ))}
        </select>
        <button className="button" onClick={load}>
          <Activity size={14} />
          Refresh
        </button>
      </div>
      <p className="proc-status" role="status">
        {sample
          ? `${sample.available ? `${all.count} processes · ${formatMemory(all.total)} resident (${formatMemory(all.own)} yours, ${formatMemory(all.other)} other users)` : "not measured"} · updated ${new Date(sample.collectedAt).toLocaleTimeString()}`
          : "Reading process memory…"}
        {stale && <span className="tag amber-tag">Stale</span>}
        {sample?.available &&
          changed.started + changed.exited > 0 &&
          ` · ${changed.started} started, ${changed.exited} exited`}
      </p>
      {notice.text && (
        <p
          className={`proc-notice ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {sample?.available && (
        <>
          <p className="proc-note">
            Bar scale: 0–{formatMemory(peak)} RSS; unchanged by sorting or
            search.
          </p>
          <ul className="proc-list" aria-label="Processes by resident memory">
            {rows.slice(0, visibleCount).map((row: ProcessSample) => (
              <li className="proc-row" key={row.pid}>
                <span className="proc-name" title={row.name}>
                  {row.name}
                  {row.relay && <span className="tag violet-tag">Relay</span>}
                  {row.uid === null ? (
                    <span className="tag">owner unknown</span>
                  ) : !row.own ? (
                    <span className="tag">other</span>
                  ) : null}
                </span>
                <span className="proc-pid">{row.pid}</span>
                <span className="proc-bar" aria-hidden>
                  <span
                    className={row.own ? "proc-fill" : "proc-fill foreign"}
                    style={{ width: `${barPercent(row.rss, peak)}%` }}
                  />
                </span>
                <span className="proc-value" title={row.memoryReason}>
                  {row.rss === null ? "Unavailable" : formatMemory(row.rss)}
                  <span className="proc-hidden">
                    {" "}
                    resident by {row.name}, process {row.pid}
                  </span>
                </span>
              </li>
            ))}
            {!rows.length && (
              <li className="proc-empty">
                No measured process matches “{query}”.
              </li>
            )}
          </ul>
          {rows.length > visibleCount && (
            <p className="proc-note">
              Showing {visibleCount} of {rows.length} matching processes.
              <button
                className="button"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              >
                Show more processes
              </button>
            </p>
          )}
          <p className="proc-note">{sample.metricLabel}</p>
        </>
      )}
    </section>
  );
}
