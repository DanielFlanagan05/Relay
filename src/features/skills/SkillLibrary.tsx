import { useState } from "react";
import { BookOpen, Download, Plus } from "lucide-react";
import type { Hook, Settings, Snapshot } from "../../types";
type Call = <T = unknown>(
  name: string,
  input?: unknown,
) => Promise<T | undefined>;
export function SkillLibrary({
  data,
  call,
  edit,
  saveSettings,
  cwd,
}: {
  data: Snapshot;
  call: Call;
  edit: (h: Hook) => void;
  saveSettings: (s: Partial<Settings>) => unknown;
  cwd: string;
}) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("all");
  const [workspace, setWorkspace] = useState(cwd);
  const [found, setFound] = useState<Hook[] | null>(null);
  const filtered = data.hooks.filter(
    (h) =>
      (category === "all" || h.category === category) &&
      `${h.name} ${h.description} ${h.content}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SHARED SKILLS</div>
          <h1>A consistent way of working.</h1>
          <p>
            Choose response preferences and task skills. Every turn saves the
            instructions it used.
          </p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            edit({
              id: crypto.randomUUID(),
              name: "",
              description: "",
              content: "",
            })
          }
        >
          <Plus size={15} />
          New instruction
        </button>
      </div>
      <div className="skill-library-toolbar">
        <input
          aria-label="Search skills"
          placeholder="Search your library…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Skill category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="all">All skills</option>
          <option value="style">Response preferences</option>
          <option value="workflow">Task skills</option>
          <option value="output">Output skills</option>
        </select>
      </div>
      <p className="subtle">
        Application and workspace defaults apply to new sessions. Session and
        next-turn selections live in the composer.
      </p>
      <div className="instruction-grid">
        {filtered.map((h) => (
          <div className="instruction-card" key={h.id}>
            <div className="instruction-card-top">
              <BookOpen size={20} />
              <span className="tag">
                v{h.revision || 1} · {h.origin || "user"}
              </span>
            </div>
            <h3>{h.name}</h3>
            <p>{h.description}</p>
            {h.requires?.length ? (
              <p className="skill-warning">
                Requires {h.requires.join(", ")} tools
              </p>
            ) : null}
            <footer>
              <button className="text-button" onClick={() => edit(h)}>
                Inspect / edit
              </button>
              <label className="switch-label">
                Default
                <button
                  role="switch"
                  aria-label={`Use ${h.name} by default`}
                  aria-checked={data.settings.defaultHooks.includes(h.id)}
                  className={`switch ${data.settings.defaultHooks.includes(h.id) ? "on" : ""}`}
                  onClick={() =>
                    saveSettings({
                      defaultHooks: data.settings.defaultHooks.includes(h.id)
                        ? data.settings.defaultHooks.filter((id) => id !== h.id)
                        : [...data.settings.defaultHooks, h.id],
                    })
                  }
                >
                  <span />
                </button>
              </label>
            </footer>
          </div>
        ))}
      </div>
      {!filtered.length && <p>No skills match this search.</p>}
      <section className="import-skills">
        <div>
          <h3>Workspace defaults and local skills</h3>
          <p>
            Import instruction-only copies from your agent directories and this
            workspace.
          </p>
        </div>
      </section>
      <div className="skill-library-toolbar">
        <input
          aria-label="Skill workspace"
          value={workspace}
          placeholder="Workspace path (optional)"
          onChange={(e) => setWorkspace(e.target.value)}
        />
        <button
          className="button"
          onClick={async () => {
            const path = await call<string>("chooseFolder");
            if (path) setWorkspace(path);
          }}
        >
          Choose folder
        </button>
        <button
          className="button"
          onClick={async () => {
            const result = await call<Hook[]>("skills", { cwd: workspace });
            if (result) setFound(result);
          }}
        >
          <Download size={14} />
          Find local skills
        </button>
      </div>
      {workspace && (
        <details className="workspace-defaults">
          <summary>Defaults for {workspace}</summary>
          <p>Inherited settings are captured when a new session is created.</p>
          {data.hooks.map((h) => {
            const selection = data.settings.workspaceHooks?.[workspace] || {
              enabled: [],
              disabled: [],
            };
            return (
              <label key={h.id}>
                {h.name}
                <select
                  aria-label={`${h.name} workspace default`}
                  value={
                    selection.enabled.includes(h.id)
                      ? "on"
                      : selection.disabled.includes(h.id)
                        ? "off"
                        : "inherit"
                  }
                  onChange={(e) =>
                    saveSettings({
                      workspaceHooks: {
                        ...data.settings.workspaceHooks,
                        [workspace]: {
                          enabled: [
                            ...selection.enabled.filter((id) => id !== h.id),
                            ...(e.target.value === "on" ? [h.id] : []),
                          ],
                          disabled: [
                            ...selection.disabled.filter((id) => id !== h.id),
                            ...(e.target.value === "off" ? [h.id] : []),
                          ],
                        },
                      },
                    })
                  }
                >
                  <option value="inherit">Use application default</option>
                  <option value="on">Enable</option>
                  <option value="off">Disable</option>
                </select>
              </label>
            );
          })}
        </details>
      )}
      {found && (
        <div className="skill-results">
          <h3>Local skills · {found.length}</h3>
          <p>
            Inspect contents before saving a copy. Supporting files are not
            imported.
          </p>
          {found.map((h) => (
            <button key={h.id} onClick={() => edit(h)}>
              <BookOpen size={16} />
              <span>
                <strong>{h.name}</strong>
                <small>{h.source}</small>
              </span>
              <Plus size={15} />
            </button>
          ))}
          {!found.length && <p>No local skills found.</p>}
        </div>
      )}
    </div>
  );
}
