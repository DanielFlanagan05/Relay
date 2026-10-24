// Memory headroom for Relay and its local models (Linux, systemd user session).
//
// - Relay moves itself, its Electron helpers and any running LocalAi runtime
//   into `relay.slice`, so everything it spawns later lands there too.
// - "Memory reserved for Relay" caps the user's other apps (`app.slice`) with
//   MemoryHigh = total RAM - reserve. Over the cap they are reclaimed into swap
//   and slowed, never killed. The cap is runtime-only and lifted when Relay
//   quits, so a closed Relay never squeezes the desktop.
// - Closing apps only ever targets app.slice units the user picked, by SIGTERM
//   (no SIGKILL follow-up), and never a unit that contains Relay or launched it.
//
// No root is needed: the user's systemd manager owns its own slices.

import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GiB = 1024 ** 3;
export const RELAY_SLICE = "relay.slice";
// Never cap the rest of the desktop below this.
export const MIN_APP_CAP_GIB = 4;

const UNIT = /^[\w@.:\\-]+\.(service|scope)$/;
// Desktop plumbing that other apps depend on; listed for context, never closed.
const DESKTOP = /^(xdg-|dbus|dconf|at-spi|pipewire|wireplumber|obex|gvfs|org\.kde\.(plasma|kwin|kded)|org\.gnome\.(Shell|SettingsDaemon))/i;
// Units below this are hidden: closing them frees nothing worth the risk.
const MIN_LISTED = 32 * 1024 ** 2;

function run(command, args) {
  return new Promise((resolve, reject) =>
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) =>
      error
        ? reject(new Error((stderr || error.message).trim().slice(0, 500)))
        : resolve(stdout),
    ),
  );
}

export class MemoryGuard {
  constructor({
    pid = process.pid,
    procRoot = "/proc",
    cgroupRoot = "/sys/fs/cgroup",
    exec = run,
    readFile = (path) => readFileSync(path, "utf8"),
    readdir = (path) => readdirSync(path),
    platform = process.platform,
  } = {}) {
    Object.assign(this, { pid, procRoot, cgroupRoot, exec, readFile, readdir, platform });
    this.state = { inRelaySlice: false, capGiB: null, error: "" };
  }
  cgroupOf(pid) {
    const line = this.readFile(`${this.procRoot}/${pid}/cgroup`)
      .split("\n")
      .find((l) => l.startsWith("0::"));
    return line ? line.slice(3).trim() : "";
  }
  // The user manager's cgroup, e.g. /user.slice/user-1000.slice/user@1000.service
  userRoot() {
    const match = this.cgroupOf(this.pid).match(/^(.*\/user@\d+\.service)(\/|$)/);
    if (!match) throw new Error("Relay is not running under a systemd user session.");
    return match[1];
  }
  parentOf(pid) {
    const stat = this.readFile(`${this.procRoot}/${pid}/stat`);
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  }
  ancestors() {
    const out = new Set();
    let pid = this.pid;
    while (pid > 1 && !out.has(pid)) {
      out.add(pid);
      try {
        pid = this.parentOf(pid);
      } catch {
        break;
      }
    }
    return out;
  }
  descendants() {
    const children = new Map();
    for (const name of this.readdir(this.procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const parent = this.parentOf(Number(name));
        children.set(parent, [...(children.get(parent) || []), Number(name)]);
      } catch {}
    }
    const out = [this.pid];
    for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]) || []));
    return out;
  }
  // Adopt Relay's existing process tree (plus a detached runtime) into a
  // transient scope in relay.slice; children spawned afterwards inherit it.
  async joinSlice(extraPids = []) {
    if (this.platform !== "linux") throw new Error("Memory slices need Linux with systemd.");
    if (this.cgroupOf(this.pid).includes(`/${RELAY_SLICE}/`)) {
      this.state.inRelaySlice = true;
      return this.state;
    }
    this.userRoot();
    // Only processes not already there: Chromium moves its main process into
    // its own app-<name>-<pid>.scope during startup, so a later pass picks up
    // stragglers into a fresh scope (systemd will not attach to a non-delegated one).
    const pids = [...new Set([...this.descendants(), ...extraPids.filter(Number.isInteger)])].filter((pid) => {
      try {
        return !this.cgroupOf(pid).includes(`/${RELAY_SLICE}/`);
      } catch {
        return false;
      }
    });
    this.scopes = (this.scopes || 0) + 1;
    await this.exec("busctl", [
      "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))",
      `relay-${this.pid}${this.scopes > 1 ? `-${this.scopes}` : ""}.scope`, "fail", "3",
      "PIDs", "au", String(pids.length), ...pids.map(String),
      "Slice", "s", RELAY_SLICE,
      "Description", "s", "Relay and its local models",
      "0",
    ]);
    // StartTransientUnit only queues a job; the move lands shortly after.
    for (let i = 0; i < 30 && !this.state.inRelaySlice; i++) {
      this.state.inRelaySlice = this.cgroupOf(this.pid).includes(`/${RELAY_SLICE}/`);
      if (!this.state.inRelaySlice) await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.state.inRelaySlice) throw new Error("systemd did not move Relay into relay.slice.");
    return this.state;
  }
  totalGiB() {
    const line = this.readFile(`${this.procRoot}/meminfo`).match(/^MemTotal:\s+(\d+) kB/m);
    if (!line) throw new Error("MemTotal is unavailable.");
    return (Number(line[1]) * 1024) / GiB;
  }
  // reserveGiB 0 lifts the cap.
  async applyReserve(reserveGiB) {
    if (!reserveGiB) {
      if (this.state.capGiB !== null)
        await this.exec("systemctl", ["--user", "set-property", "--runtime", "app.slice", "MemoryHigh=infinity"]);
      this.state.capGiB = null;
      return this.state;
    }
    // Capping app.slice while Relay is still inside it would throttle Relay itself.
    if (!this.state.inRelaySlice)
      throw new Error("Relay is not in relay.slice, so other apps cannot be capped without capping Relay.");
    const capGiB = Math.floor(this.totalGiB() - reserveGiB);
    if (capGiB < MIN_APP_CAP_GIB)
      throw new Error(`A ${reserveGiB} GiB reserve would leave other apps under ${MIN_APP_CAP_GIB} GiB.`);
    await this.exec("systemctl", ["--user", "set-property", "--runtime", "app.slice", `MemoryHigh=${capGiB}G`]);
    this.state.capGiB = capGiB;
    return this.state;
  }
  // Quit path: synchronous so the cap is gone before the process exits.
  releaseSync() {
    if (this.state.capGiB === null) return;
    try {
      execFileSync("systemctl", ["--user", "set-property", "--runtime", "app.slice", "MemoryHigh=infinity"], { timeout: 5000 });
      this.state.capGiB = null;
    } catch {}
  }
  async sync(reserveGiB, extraPids = []) {
    this.state.error = "";
    try {
      await this.joinSlice(extraPids);
    } catch (error) {
      this.state.error = error.message;
    }
    try {
      await this.applyReserve(reserveGiB);
    } catch (error) {
      this.state.error ||= error.message;
    }
    return this.status();
  }
  bytes(path) {
    const n = Number(this.readFile(path).trim());
    return Number.isFinite(n) ? n : null;
  }
  status() {
    let appSliceGiB = null;
    let relaySliceGiB = null;
    try {
      const root = join(this.cgroupRoot, this.userRoot());
      appSliceGiB = this.bytes(join(root, "app.slice/memory.current")) / GiB;
      if (this.state.inRelaySlice)
        relaySliceGiB = this.bytes(join(root, RELAY_SLICE, "memory.current")) / GiB;
    } catch {}
    return { ...this.state, appSliceGiB, relaySliceGiB };
  }
  // Every app unit in app.slice, largest first. Units that contain Relay or one
  // of its ancestors (the terminal or launcher that started it) are protected.
  apps() {
    const root = join(this.cgroupRoot, this.userRoot(), "app.slice");
    const keep = this.ancestors();
    const out = [];
    for (const unit of this.readdir(root)) {
      if (!UNIT.test(unit)) continue;
      let pids = [];
      try {
        pids = this.readFile(join(root, unit, "cgroup.procs")).split("\n").filter(Boolean).map(Number);
      } catch {}
      if (!pids.length) continue;
      const processes = pids.map((pid) => {
        let name = "";
        try {
          name = this.readFile(`${this.procRoot}/${pid}/comm`).trim();
        } catch {}
        return { pid, name: name || `[${pid}]` };
      });
      let bytes = null;
      try {
        bytes = this.bytes(join(root, unit, "memory.current"));
      } catch {}
      if (bytes !== null && bytes < MIN_LISTED) continue;
      const name = displayName(unit);
      out.push({
        unit,
        name,
        bytes,
        processes,
        protected: pids.some((pid) => keep.has(pid))
          ? "Relay runs inside this app or was launched from it."
          : DESKTOP.test(name)
            ? "Desktop service other apps depend on."
            : "",
      });
    }
    return out.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  }
  // Only units the user picked from a fresh listing, and never protected ones.
  async close(units) {
    const listed = new Map(this.apps().map((app) => [app.unit, app]));
    const results = [];
    for (const unit of units) {
      const app = listed.get(unit);
      if (!app || !UNIT.test(unit)) {
        results.push({ unit, ok: false, error: "No longer running." });
        continue;
      }
      if (app.protected) {
        results.push({ unit, ok: false, error: app.protected });
        continue;
      }
      try {
        await this.exec("systemctl", ["--user", "kill", "--signal=SIGTERM", "--", unit]);
        results.push({ unit, ok: true });
      } catch (error) {
        results.push({ unit, ok: false, error: error.message });
      }
    }
    return results;
  }
}

// app-brave-browser@3f2c….service -> brave-browser; app-com.anthropic.Claude-9589.scope -> com.anthropic.Claude
export function displayName(unit) {
  return unit
    .replace(/\.(service|scope)$/, "")
    .replace(/^app-/, "")
    .replace(/@[^@]*$/, "")
    .replace(/-\d+$/, "")
    .replace(/\\x2d/g, "-");
}
