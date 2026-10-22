import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import * as csstree from "css-tree";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const MAX_ARTIFACT_BYTES = 128 * 1024;
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const window = new JSDOM("").window;
const purify = createDOMPurify(window);
const allowedTags =
  "main article section header footer aside nav h1 h2 h3 h4 h5 h6 p div span strong em b i u s small sub sup blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col hr br details summary figure figcaption time mark a".split(
    " ",
  );
const properties = new Set(
  "color background background-color font font-family font-size font-weight font-style font-variant line-height letter-spacing word-spacing text-align text-decoration text-transform text-indent white-space overflow-wrap word-break vertical-align display visibility opacity width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-radius border-top border-right border-bottom border-left border-collapse border-spacing box-sizing box-shadow position top right bottom left inset z-index overflow overflow-x overflow-y flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap grid grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow grid-auto-columns grid-auto-rows order list-style list-style-type list-style-position table-layout content counter-reset counter-increment break-before break-after break-inside page-break-before page-break-after page-break-inside print-color-adjust color-scheme aspect-ratio".split(
    " ",
  ),
);
const functions = new Set(
  "rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp minmax repeat fit-content linear-gradient radial-gradient repeating-linear-gradient counter counters".split(
    " ",
  ),
);
export function sanitizeCSS(source, inline = false) {
  if (Buffer.byteLength(source) > MAX_ARTIFACT_BYTES)
    throw new Error("CSS exceeds 128 KiB");
  const ast = csstree.parse(source, {
    context: inline ? "declarationList" : "stylesheet",
    parseCustomProperty: true,
    onParseError: (e) => {
      throw e;
    },
  });
  let count = 0,
    depth = 0;
  csstree.walk(ast, {
    enter(node) {
      if (++count > 12000 || ++depth > 80)
        throw new Error("CSS is too complex to preview");
    },
    leave() {
      depth--;
    },
  });
  csstree.walk(ast, {
    visit: "Atrule",
    enter(node, item, list) {
      if (!["media", "supports"].includes(node.name.toLowerCase())) {
        list.remove(item);
        return csstree.walk.skip;
      }
    },
  });
  csstree.walk(ast, {
    visit: "Declaration",
    enter(node, item, list) {
      let safe = properties.has(node.property.toLowerCase());
      csstree.walk(node.value, (value) => {
        if (
          value.type === "Url" ||
          value.type === "Raw" ||
          (value.type === "Function" &&
            !functions.has(value.name.toLowerCase()))
        )
          safe = false;
      });
      if (!safe) list.remove(item);
    },
  });
  // Reject unsupported parser recovery and obfuscated resource/function names anywhere else.
  csstree.walk(ast, (node) => {
    if (node.type === "Raw" || node.type === "Url")
      throw new Error("Unsupported CSS syntax");
  });
  return csstree.generate(ast).replace(/</g, "\\3c ");
}
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style") {
    try {
      data.attrValue = sanitizeCSS(data.attrValue, true);
    } catch {
      data.keepAttr = false;
    }
  }
});
const escape = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function validateArtifact(input) {
  if (
    !input ||
    input.version !== 1 ||
    input.type !== "html-css" ||
    typeof input.html !== "string" ||
    typeof input.css !== "string" ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 200
  )
    throw new Error(
      "Expected version 1 html-css artifact with title, html, and css strings",
    );
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_ARTIFACT_BYTES)
    throw new Error("Artifact exceeds 128 KiB");
  const fragment = purify.sanitize(input.html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: [
      "id",
      "class",
      "style",
      "title",
      "role",
      "aria-label",
      "aria-labelledby",
      "aria-describedby",
      "colspan",
      "rowspan",
      "scope",
      "datetime",
      "open",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const walker = window.document.createTreeWalker(
    fragment,
    window.NodeFilter.SHOW_ELEMENT,
  );
  let node,
    count = 0;
  while ((node = walker.nextNode())) {
    if (++count > 3000) throw new Error("HTML exceeds 3000 elements");
    let depth = 0;
    for (let p = node; p; p = p.parentNode)
      if (++depth > 80) throw new Error("HTML nesting exceeds 80 levels");
  }
  const warnings = purify.removed.length
    ? ["Unsupported HTML elements or attributes were removed."]
    : [];
  const container = window.document.createElement("div");
  container.append(fragment);
  const html = container.innerHTML,
    css = sanitizeCSS(input.css);
  if (css !== input.css.replace(/\s/g, ""))
    warnings.push(
      "CSS was parsed and restricted to static layout and typography.",
    );
  const title = input.title.trim();
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;margin:0;padding:20px;line-height:1.6;overflow-wrap:anywhere}*{box-sizing:border-box}table{border-collapse:collapse;max-width:100%}td,th{padding:8px;border:1px solid #888}pre{white-space:pre-wrap}a{pointer-events:none}${css}</style></head><body>${html}</body></html>`;
  return { title, html, css, document, warnings };
}
export function extractArtifacts(content) {
  const blocks = [],
    errors = [];
  // Completed fences only. Streaming text never reaches this parser.
  const re =
    /^```relay-artifact[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*(?:\r?\n|$)/gm;
  for (const match of content.matchAll(re)) {
    if (blocks.length + errors.length >= 4) {
      errors.push("Only four artifacts per answer are supported.");
      break;
    }
    try {
      if (Buffer.byteLength(match[1]) > MAX_ARTIFACT_BYTES)
        throw new Error("Artifact exceeds 128 KiB");
      const input = JSON.parse(match[1]);
      const safe = validateArtifact(input);
      blocks.push({ source: input, ...safe });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { blocks, errors };
}
export class ArtifactStore {
  constructor(directory) {
    this.directory = join(directory, "artifacts");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  put(session, message, block) {
    const previous = session.messages
      .flatMap((m) => m.artifacts || [])
      .filter((a) => a.title === block.title);
    const record = {
      id: randomUUID(),
      sessionId: session.id,
      messageId: message.id,
      title: block.title,
      revision: Math.max(0, ...previous.map((a) => a.revision)) + 1,
      createdAt: new Date().toISOString(),
      warnings: block.warnings,
    };
    const body = JSON.stringify({ ...record, source: block.source });
    const file = join(this.directory, `${record.id}.json`);
    writeFileSync(file + ".tmp", body, { mode: 0o600 });
    renameSync(file + ".tmp", file);
    record.hash = createHash("sha256").update(body).digest("hex");
    return record;
  }
  get(record) {
    if (!/^[0-9a-f-]{36}$/.test(record.id))
      throw new Error("Invalid artifact ID");
    const file = join(this.directory, `${record.id}.json`);
    if (!existsSync(file))
      throw new Error(
        "Artifact source is missing; the original output is still in the conversation.",
      );
    const raw = readFileSync(file, "utf8");
    if (createHash("sha256").update(raw).digest("hex") !== record.hash)
      throw new Error("Artifact source failed its integrity check");
    const value = JSON.parse(raw);
    // Always revalidate on read/export; a persisted preview never bypasses the current policy.
    return {
      ...record,
      source: value.source,
      ...validateArtifact(value.source),
    };
  }
}
