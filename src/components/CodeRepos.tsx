"use client";

import { useEffect, useId, useState } from "react";

/**
 * Settings → Code repos: the repos xkg matches captures to. A repo gets a map
 * from the user's machine (the xkg git hook) or, added here, from its file
 * names on GitHub.
 */

interface CodeRepo {
  repo: string;
  source: "local" | "github";
  files: number;
  truncated: boolean;
  syncedAt: string;
}

const SOURCE_LABEL: Record<CodeRepo["source"], string> = {
  local: "Your machine",
  github: "GitHub, names only",
};

const LOAD_ERROR = "Couldn't load your code repos. Try again in a moment.";
const SAVE_ERROR = "Couldn't save that. Try again in a moment.";

function syncedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ` · synced ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

async function send(method: "POST" | "DELETE", repo: string): Promise<{ repos?: CodeRepo[]; error?: string }> {
  try {
    const res = await fetch("/api/code-repos", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo }),
    });
    const data = (await res.json().catch(() => ({}))) as { repos?: CodeRepo[]; error?: string };
    if (res.ok && Array.isArray(data.repos)) return { repos: data.repos };
    return { error: res.status < 500 && typeof data.error === "string" ? data.error : SAVE_ERROR };
  } catch {
    return { error: SAVE_ERROR };
  }
}

export default function CodeRepos({ cardStyle, inputClass }: { cardStyle: React.CSSProperties; inputClass: string }) {
  const titleId = useId();
  const inputId = useId();
  const [repos, setRepos] = useState<CodeRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/code-repos")
      .then(async (res) => {
        const data = (await res.json()) as { repos?: CodeRepo[] };
        if (!res.ok || !Array.isArray(data.repos)) throw new Error(String(res.status));
        if (live) setRepos(data.repos);
      })
      .catch(() => { if (live) setError(LOAD_ERROR); });
    return () => { live = false; };
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy("add");
    setError(null);
    const result = await send("POST", draft.trim());
    setBusy(null);
    if (result.repos) {
      setRepos(result.repos);
      setDraft("");
    } else {
      setError(result.error ?? SAVE_ERROR);
    }
  }

  async function remove(repo: string) {
    if (busy) return;
    setBusy(repo);
    setError(null);
    const result = await send("DELETE", repo);
    setBusy(null);
    if (result.repos) setRepos(result.repos);
    else setError(result.error ?? SAVE_ERROR);
  }

  return (
    <section aria-labelledby={titleId}>
      <p id={titleId} className="eyebrow px-1 mb-2" style={{ color: "var(--gold)" }}>
        Code repos
      </p>
      <div className="rounded-2xl p-4 stack-4" style={cardStyle}>
        <p className="text-xs leading-relaxed" style={{ color: "var(--fg-muted)" }}>
          xkg suggests where a capture applies in these repos. It keeps file and function names, signatures and each file&apos;s opening comment line, never code.
        </p>

        {repos && repos.length === 0 && (
          <p className="text-sm" style={{ color: "var(--fg)" }}>
            No code repos yet. Commit in a repo with the xkg git hook, or add one from GitHub below.
          </p>
        )}

        {repos && repos.length > 0 && (
          <ul className="stack-3">
            {repos.map((r) => (
              <li key={r.repo} className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm break-all" style={{ color: "var(--fg)" }}>{r.repo}</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
                    {SOURCE_LABEL[r.source] ?? r.source}{syncedOn(r.syncedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(r.repo)}
                  disabled={busy !== null}
                  aria-label={`Remove ${r.repo}`}
                  className="btn-secondary shrink-0 text-sm font-medium rounded-xl px-3 py-2 disabled:opacity-40"
                >
                  {busy === r.repo ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(e) => void add(e)} style={{ borderTop: "1px solid var(--gold-faint)", paddingTop: 16 }}>
          <label htmlFor={inputId} className="card-title block mb-1" style={{ color: "var(--fg)" }}>
            Add a repo from GitHub
          </label>
          <p className="text-xs leading-relaxed mb-2" style={{ color: "var(--fg-muted)" }}>
            xkg reads its file names with your GitHub sign-in. A sync from your machine replaces them.
          </p>
          <div className="flex items-center gap-2">
            <input
              id={inputId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="owner/name"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={`${inputClass} flex-1 min-w-0`}
            />
            <button
              type="submit"
              disabled={!draft.trim() || busy !== null}
              className="shrink-0 text-sm font-medium rounded-xl px-3 py-2.5 disabled:opacity-40"
              style={{ background: "var(--btn)", color: "var(--btn-fg)" }}
            >
              {busy === "add" ? "Adding…" : "Add"}
            </button>
          </div>
        </form>

        {error && (
          <p role="alert" className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>
        )}
      </div>
    </section>
  );
}
