// Real Electron renderer, synthetic process data only. No Relay runtime or models.
import { _electron } from "playwright";
import { buildSync } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const dir = mkdtempSync(join(tmpdir(), "relay-compute-fixture-"));
let app;
try {
  writeFileSync(
    join(dir, "entry.tsx"),
    `
import React, {useEffect,useState} from ${JSON.stringify(resolve("node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(resolve("node_modules/react-dom/client.js"))};
import {ProcessMemory} from ${JSON.stringify(resolve("src/features/compute/ProcessMemory.tsx"))};
window.calls=0;window.fail=false;
function Fixture(){const [tick,setTick]=useState(0);useEffect(()=>{const t=setInterval(()=>setTick(n=>n+1),50);return()=>clearInterval(t)},[]);
return <><output aria-label="Snapshot updates">{tick}</output><ProcessMemory call={async()=>{window.calls++;await new Promise(r=>setTimeout(r,200));if(window.fail)throw Error('fixture collection failure');return {available:true,metric:'RSS',metricLabel:'RSS includes shared pages',collectedAt:new Date().toISOString(),system:{totalGiB:32,availableGiB:12},errors:[],processes:Array.from({length:1205},(_,i)=>({pid:i+1,name:i===0?'Z largest':'A process '+i,rss:i===0?1024**3:1024**2,own:true,uid:1000}))};}} /></>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  );
  buildSync({
    entryPoints: [join(dir, "entry.tsx")],
    outfile: join(dir, "entry.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    absWorkingDir: process.cwd(),
    nodePaths: [resolve("node_modules")],
  });
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${resolve("src/styles.css")}"></head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>`,
  );
  writeFileSync(
    join(dir, "main.cjs"),
    `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1100,height:850,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(join(dir, "index.html"))});});`,
  );
  app = await _electron.launch({
    args: [join(dir, "main.cjs")],
    env: { ...process.env },
  });
  const page = await app.firstWindow();
  await page.locator(".proc-row").first().waitFor();
  await page.getByLabel("Sort processes").selectOption("name");
  const width = await page
    .locator(".proc-row")
    .filter({ hasText: "A process 1" })
    .first()
    .locator(".proc-fill")
    .evaluate((e) => e.style.width);
  assert.ok(
    parseFloat(width) < 1,
    "name sort must not rescale small processes to 100%",
  );
  while (
    await page.getByRole("button", { name: "Show more processes" }).count()
  )
    await page.getByRole("button", { name: "Show more processes" }).click();
  assert.equal(await page.locator(".proc-row").count(), 1205);
  await page.getByLabel("Search process by name or PID").fill("1205");
  assert.equal(await page.locator(".proc-row").count(), 1);
  await page.getByLabel("Search process by name or PID").fill("");
  await page.waitForFunction(() => window.calls >= 2);
  assert.ok(
    (await page.evaluate(() => window.calls)) <= 3,
    "snapshot re-renders must not restart polling",
  );
  await page.evaluate(() => (window.fail = true));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "fixture collection failure" })
    .waitFor();
  assert.ok(
    (await page.locator(".proc-row").count()) > 0,
    "last successful sample survives a failure",
  );
  const before = await page.evaluate(() => window.calls);
  await page.waitForTimeout(5500);
  assert.equal(
    await page.evaluate(() => window.calls),
    before,
    "error pauses automatic polling",
  );
  await page.evaluate(() => (window.fail = false));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
  mkdirSync(resolve("artifacts"), { recursive: true });
  await page.screenshot({ path: resolve("artifacts/review-compute.png") });
  console.log(
    "Compute renderer passed: stable polling under snapshot updates, truthful bar scale, full-list pagination/search, failure preservation and recovery.",
  );
} finally {
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}
