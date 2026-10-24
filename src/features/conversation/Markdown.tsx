import { memo, useMemo, useState, type ReactNode, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";

function CodeBlock({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState(""),
    [previewError, setPreviewError] = useState("");
  const [wrap, setWrap] = useState(false),
    [copied, setCopied] = useState("Copy");
  const props = isValidElement<{ className?: string; children?: ReactNode }>(
    children,
  )
    ? children.props
    : {};
  const source = String(props.children ?? ""),
    language = props.className?.replace("language-", "") || "text";
  const highlighted = useMemo(
    () =>
      source.length < 50000 && hljs.getLanguage(language)
        ? hljs.highlight(source, { language, ignoreIllegals: true }).value
        : null,
    [source, language],
  );
  const block = (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        {language === "html" && (
          <button
            onClick={async () => {
              try {
                const result = await window.relay.call<{ document: string }>(
                  "previewHtml",
                  { html: source },
                );
                setPreview(result.document);
              } catch (e) {
                setPreviewError((e as Error).message);
              }
            }}
          >
            Preview HTML
          </button>
        )}
        <button onClick={() => setWrap(!wrap)} aria-pressed={wrap}>
          Wrap
        </button>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(source);
              setCopied("Copied");
            } catch {
              setCopied("Copy failed");
            }
          }}
        >
          {copied}
        </button>
      </div>
      <pre style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>
        {highlighted ? (
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{source}</code>
        )}
      </pre>
      {previewError && <p role="alert">{previewError}</p>}
      {preview && (
        <>
          <button className="button" onClick={() => setPreview("")}>
            Close preview
          </button>
          <iframe
            className="manual-preview"
            title="HTML code preview"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={preview}
          />
        </>
      )}
    </div>
  );
  return language === "relay-artifact" ? (
    <details className="artifact-source">
      <summary>Artifact source</summary>
      {block}
    </details>
  ) : (
    block
  );
}
// Memoized on the message string: a workspace snapshot re-renders the whole
// message list every ~70 ms while any session streams, and re-parsing an
// unchanged document through react-markdown dominated that cost
// (coordination/round4/B.perf.md; tests/markdown_memo.test.mjs).
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a
            className="markdown-link"
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (href)
                window.relay
                  .call("openExternal", { url: href })
                  .catch(() => {});
            }}
          >
            {children}
          </a>
        ),
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
});
