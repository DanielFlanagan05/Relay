// relay.slice placement, the app.slice cap, and closing apps — against a fake
// /proc and cgroup tree with a recording exec. Nothing touches systemd.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryGuard, displayName, GiB } from "../electron/memoryGuard.mjs";

const USER = "/user.slice/user-1000.slice/user@1000.service";
function fixture({ inRelay = false } = {}) {
  const files = {
    "/proc/meminfo": `MemTotal:       ${124 * 1024 * 1024} kB\n`,
    // terminal 50 -> shell 60 -> relay 100 -> renderer 101; brave 200; other 300
    "/proc/50/stat": "50 (konsole) S 1 0", "/proc/60/stat": "60 (fish) S 50 0",
    "/proc/100/stat": "100 (electron) S 60 0", "/proc/101/stat": "101 (electron) S 100 0",
    "/proc/200/stat": "200 (brave) S 1 0", "/proc/300/stat": "300 (ChatGPT) S 1 0",
    "/proc/200/comm": "brave\n", "/proc/300/comm": "ChatGPT\n", "/proc/50/comm": "konsole\n",
    "/proc/100/cgroup": `0::${USER}/${inRelay ? "relay.slice/relay-100.scope" : "app.slice/app-konsole-1.scope"}\n`,
    "/proc/101/cgroup": `0::${USER}/app.slice/app-konsole-1.scope\n`,
    "/proc/4242/cgroup": `0::${USER}/app.slice/app-konsole-1.scope\n`,
    [`/cg${USER}/app.slice/memory.current`]: String(13 * GiB),
    [`/cg${USER}/relay.slice/memory.current`]: String(95 * GiB),
    [`/cg${USER}/app.slice/app-brave-browser@ab12.service/cgroup.procs`]: "200\n",
    [`/cg${USER}/app.slice/app-brave-browser@ab12.service/memory.current`]: String(4 * GiB),
    [`/cg${USER}/app.slice/app-chatgpt@cd34.service/cgroup.procs`]: "300\n",
    [`/cg${USER}/app.slice/app-chatgpt@cd34.service/memory.current`]: String(2 * GiB),
    [`/cg${USER}/app.slice/app-konsole-1.scope/cgroup.procs`]: "50\n60\n",
    [`/cg${USER}/app.slice/app-konsole-1.scope/memory.current`]: String(1 * GiB),
  };
  const calls = [];
  const guard = new MemoryGuard({
    pid: 100,
    platform: "linux",
    cgroupRoot: "/cg",
    readFile: (path) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path];
    },
    readdir: (path) =>
      path === "/proc"
        ? ["50", "60", "100", "101", "200", "300", "self"]
        : ["app-brave-browser@ab12.service", "app-chatgpt@cd34.service", "app-konsole-1.scope", "memory.current"],
    exec: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "busctl") files["/proc/100/cgroup"] = `0::${USER}/relay.slice/relay-100.scope\n`;
      return "";
    },
  });
  return { guard, calls, files };
}

test("Relay adopts its whole process tree and the runtime into relay.slice", async () => {
  const { guard, calls } = fixture();
  await guard.joinSlice([4242, undefined]);
  const call = calls[0];
  assert.equal(call[0], "busctl");
  assert.ok(call.includes("relay-100.scope") && call.includes("relay.slice"));
  const pids = call.slice(call.indexOf("au") + 2, call.indexOf("Slice"));
  assert.deepEqual(pids.sort(), ["100", "101", "4242"]);
  assert.equal(guard.state.inRelaySlice, true);
});

test("a main process re-scoped by Chromium after the first move is adopted into a fresh scope", async () => {
  const { guard, calls, files } = fixture();
  await guard.joinSlice();
  // Chromium moves the main process into its own app scope; the renderer stays.
  files["/proc/100/cgroup"] = `0::${USER}/app.slice/app-relay-100.scope\n`;
  files["/proc/101/cgroup"] = `0::${USER}/relay.slice/relay-100.scope\n`;
  guard.state.inRelaySlice = false;
  await guard.joinSlice();
  const call = calls[1];
  assert.ok(call.includes("relay-100-2.scope"));
  assert.deepEqual(call.slice(call.indexOf("au") + 2, call.indexOf("Slice")), ["100"]);
  assert.equal(guard.state.inRelaySlice, true);
});

test("the reserve caps app.slice at total minus reserve, runtime-only, and 0 lifts it", async () => {
  const { guard, calls } = fixture({ inRelay: true });
  const status = await guard.sync(100);
  assert.equal(status.error, "");
  assert.equal(status.capGiB, 24);
  assert.equal(status.appSliceGiB, 13);
  assert.equal(status.relaySliceGiB, 95);
  assert.deepEqual(calls.at(-1), ["systemctl", "--user", "set-property", "--runtime", "app.slice", "MemoryHigh=24G"]);
  await guard.sync(0);
  assert.deepEqual(calls.at(-1).at(-1), "MemoryHigh=infinity");
  assert.equal(guard.state.capGiB, null);
});

test("no cap is applied while Relay itself is still in app.slice, or one that starves the desktop", async () => {
  const { guard, calls } = fixture();
  guard.joinSlice = async () => { throw new Error("busctl unavailable"); };
  const status = await guard.sync(100);
  assert.match(status.error, /busctl unavailable/);
  assert.equal(calls.length, 0);
  const inRelay = fixture({ inRelay: true });
  assert.match((await inRelay.guard.sync(122)).error, /under 4 GiB/);
  assert.equal(inRelay.calls.length, 0);
});

test("apps are listed largest first; the app Relay was launched from is protected", () => {
  const { guard } = fixture();
  const apps = guard.apps();
  assert.deepEqual(apps.map((a) => a.name), ["brave-browser", "chatgpt", "konsole"]);
  assert.deepEqual(apps[0].processes, [{ pid: 200, name: "brave" }]);
  assert.equal(apps[0].protected, "");
  assert.match(apps[2].protected, /launched/);
});

test("closing sends SIGTERM to picked units only, never protected or unknown ones", async () => {
  const { guard, calls } = fixture();
  const results = await guard.close(["app-chatgpt@cd34.service", "app-konsole-1.scope", "evil.service"]);
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
  assert.deepEqual(calls, [["systemctl", "--user", "kill", "--signal=SIGTERM", "--", "app-chatgpt@cd34.service"]]);
});

test("tiny units are hidden and desktop services are protected", () => {
  const { guard, files } = fixture();
  files[`/cg${USER}/app.slice/app-chatgpt@cd34.service/memory.current`] = String(1024 ** 2);
  files[`/cg${USER}/app.slice/app-brave-browser@ab12.service/cgroup.procs`] = "200\n";
  assert.deepEqual(guard.apps().map((a) => a.name), ["brave-browser", "konsole"]);
  const portal = fixture();
  portal.guard.readdir = (path) => (path === "/proc" ? ["100"] : ["xdg-desktop-portal-gtk.service"]);
  portal.files[`/cg${USER}/app.slice/xdg-desktop-portal-gtk.service/cgroup.procs`] = "300\n";
  portal.files[`/cg${USER}/app.slice/xdg-desktop-portal-gtk.service/memory.current`] = String(GiB);
  assert.match(portal.guard.apps()[0].protected, /Desktop service/);
});

test("unit names become readable app names", () => {
  assert.equal(displayName("app-com.anthropic.Claude-9589.scope"), "com.anthropic.Claude");
  assert.equal(displayName("app-brave-browser@3f2c.service"), "brave-browser");
  assert.equal(displayName("app-org.kde.konsole\\x2dterm-12.scope"), "org.kde.konsole-term");
});
