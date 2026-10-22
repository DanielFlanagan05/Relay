import { spawn } from "node:child_process";
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
let electron;
const stop = () => {
  vite.kill();
  electron?.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (let i = 0; i < 100; i++) {
  try {
    const result = await fetch("http://127.0.0.1:5173");
    if (result.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
electron = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env: { ...process.env, RELAY_DEV_URL: "http://127.0.0.1:5173" },
});
electron.on("exit", (code) => {
  vite.kill();
  process.exit(code || 0);
});
