// Regression: unchanged messages must not re-parse their Markdown on every
// workspace snapshot. The service emits a full `changed` snapshot every ~70 ms
// while any session streams (electron/service.mjs changed()), App.tsx re-renders
// the whole message list with fresh objects, and every <Markdown> re-parse of
// an UNCHANGED message costs a full react-markdown pipeline run
// (coordination/round4/B.perf.md). Markdown is React.memoized, so a parent
// re-render with identical content must be far cheaper than the first render.
//
//   node --test tests/markdown_memo.test.mjs
//
// Mounts the REAL src/features/conversation/Markdown.tsx (bundled by esbuild,
// same pattern as scripts/status-render-smoke.mjs) in jsdom via react-dom/client.
// No Electron, no network, no model.

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createElement, useState, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(root, "node_modules", ".relay-markdown-memo-"));
const outfile = join(dir, "markdown.mjs");
await build({
  stdin: {
    contents: `export { Markdown } from "./src/features/conversation/Markdown";\n`,
    resolveDir: root,
    sourcefile: "memo-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  logLevel: "silent",
  external: ["react", "react-dom", "react/jsx-runtime"],
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

const { Markdown } = await import(outfile);

const message = (i) =>
  [
    `## Finding ${i}`,
    "The scheduler admits sessions while the store persists the transcript and the runtime streams tokens back to the renderer. ".repeat(
      6,
    ),
    "```typescript\n" +
      Array.from(
        { length: 20 },
        (_, k) => `  const value${k} = compute(${k}) + offset; // ${i}`,
      ).join("\n") +
      "\n```",
    "- a bullet about " + i,
    "- another bullet",
  ].join("\n\n");

const MESSAGES = Array.from({ length: 30 }, (_, i) => message(i));

test("renders markdown with highlighted code and formatting", () => {
  const html = renderToStaticMarkup(createElement(Markdown, null, MESSAGES[0]));
  assert.match(html, /<h2[^>]*>Finding 0<\/h2>/);
  assert.match(html, /hljs-keyword|class="hljs/);
  assert.match(html, /<ul>/);
});

test("a parent re-render with unchanged content skips full markdown re-parsing", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
  });
  for (const key of ["window", "document", "HTMLElement", "Node", "Element", "Event"])
    if (!globalThis[key])
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");

  // Parent state changes force a re-render of every child on each workspace
  // snapshot; the message strings stay byte-identical, exactly like a
  // `relay:changed` event that touches a different session.
  let setTick;
  function Parent({ tick }) {
    return createElement(
      "div",
      null,
      ...MESSAGES.map((m, i) =>
        createElement(Markdown, { key: i, children: m }),
      ),
      createElement("span", { id: "tick" }, String(tick)),
    );
  }
  function Harness() {
    const [tick, _setTick] = useState(0);
    setTick = _setTick;
    return createElement(Parent, { tick });
  }

  const container = dom.window.document.getElementById("root");
  const reactRoot = createRoot(container);

  let t0 = 0;
  let t1 = 0;
  // Time the whole act() flush: React 19 roots render concurrently, so the
  // work lands when act drains, not inside the callback.
  const startedFirst = performance.now();
  await act(async () => {
    reactRoot.render(createElement(Harness));
  });
  t0 = performance.now() - startedFirst;
  assert.match(container.innerHTML, /Finding 29/);
  for (let round = 1; round <= 3; round++) {
    const started = performance.now();
    await act(async () => {
      setTick(round);
    });
    if (round === 1) t1 = performance.now() - started;
  }
  assert.equal(container.querySelector("#tick").textContent, "3");

  const ratio = t1 / t0;
  t.diagnostic(
    `first render ${t0.toFixed(1)} ms; no-op re-render ${t1.toFixed(1)} ms; ratio ${ratio.toFixed(2)}`,
  );
  // Without memoization the re-render re-parses all 30 documents and the ratio
  // is ~1; memoized Markdown only re-renders the tick span (ratio << 1).
  assert.ok(
    ratio < 0.35,
    `no-op re-render cost ${t1.toFixed(1)}ms vs first render ${t0.toFixed(1)}ms (ratio ${ratio.toFixed(
      2,
    )} >= 0.35): unchanged messages are re-parsing their markdown`,
  );
  reactRoot.unmount();
});
