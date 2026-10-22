import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateArtifact,
  sanitizeCSS,
  extractArtifacts,
  ArtifactStore,
} from "../electron/artifacts.mjs";
const sample = (extra = {}) => ({
  version: 1,
  type: "html-css",
  title: "Report",
  html: "<main><h1>Report</h1><p>Ready</p></main>",
  css: "main { padding: 20px; color: #123456; }",
  ...extra,
});
test("static artifacts preserve semantic layout and cannot inject scripts or navigation", () => {
  const value = validateArtifact(
    sample({
      title: "</title><script>bad()</script>",
      html: '<main style="color:red;background:url(https://bad.test)"><h1>Good</h1><script>bad()</script><img src="http://127.0.0.1:9999"><iframe src="file:///etc/passwd"></iframe><a href="https://bad.test" onclick="bad()">Link</a><form action="https://bad.test"><input></form><svg onload="bad()"></svg><meta http-equiv="refresh" content="0;url=https://bad.test"></main>',
    }),
  );
  assert.match(value.html, /<h1>Good<\/h1>/);
  assert.doesNotMatch(
    value.html,
    /<script|<iframe|<form|<svg|<meta|onclick|href=|url\(/i,
  );
  assert.doesNotMatch(value.document, /<script/i);
  assert.match(value.document, /script-src 'none'/);
});
test("CSS parser strips external resources, animations and unknown properties; escapes closing tags", () => {
  const css = sanitizeCSS(
    '@import "https://bad.test"; @font-face{src:url(x)} p {color:red; background:url(x); animation: spin 1s; content:"</style><script>bad()</script>"}',
  );
  assert.doesNotMatch(css, /@import|@font-face|url\(|animation|<\/style/i);
  assert.match(css, /color:red/);
  assert.throws(() => sanitizeCSS("p { color: } }"));
});
test("fenced extraction accepts complete supported blocks only and preserves errors", () => {
  const raw = "```relay-artifact\n" + JSON.stringify(sample()) + "\n```\n";
  assert.equal(extractArtifacts(raw).blocks.length, 1);
  assert.equal(extractArtifacts(raw.slice(0, -4)).blocks.length, 0);
  assert.equal(extractArtifacts("```html\n<h1>Hi</h1>\n```").blocks.length, 0);
  assert.equal(
    extractArtifacts('```relay-artifact\n{"version":9}\n```').errors.length,
    1,
  );
  assert.equal(extractArtifacts(raw.repeat(5)).blocks.length, 4);
  assert.throws(
    () => validateArtifact(sample({ html: "a".repeat(128 * 1024) })),
    /128 KiB/,
  );
  assert.throws(
    () =>
      validateArtifact(
        sample({ html: "<div>".repeat(90) + "x" + "</div>".repeat(90) }),
      ),
    /nesting/,
  );
});
test("immutable revision files survive reopening and validate integrity before export", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-artifact-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ArtifactStore(dir),
    message = { id: "m", artifacts: [] },
    session = { id: "s", messages: [message] },
    source = sample();
  const record = store.put(session, message, {
    ...validateArtifact(source),
    source,
  });
  message.artifacts.push(record);
  const second = store.put(session, message, {
    ...validateArtifact(source),
    source,
  });
  assert.equal(second.revision, 2);
  assert.match(new ArtifactStore(dir).get(record).document, /<h1>Report/);
  writeFileSync(join(dir, "artifacts", record.id + ".json"), "{}");
  assert.throws(() => store.get(record), /integrity/);
});
