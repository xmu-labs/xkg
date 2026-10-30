/**
 * GitHub API helpers.
 * Centralizes all GitHub content API interactions.
 */

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = { Accept: "application/vnd.github+json" };

/**
 * Encode a repo-relative path for use in a GitHub contents URL.
 *
 * Interpolating a raw path here is unsafe: the WHATWG URL parser normalizes
 * dot-segments, so a filename like `../../../../user/repos` walks out of the
 * contents endpoint entirely and the request lands on a different GitHub API
 * endpoint — carrying the user's repo-scoped token. Unencoded `?` and `#` can
 * likewise rewrite the query or truncate the path. Since capture filenames
 * reach these helpers from LLM tool arguments derived from untrusted captured
 * content, that is reachable by prompt injection.
 *
 * Each segment is encoded and traversal/empty segments are rejected outright.
 */
export function encodeRepoPath(filePath: string): string {
  const segments = filePath.split("/").filter((s, i, arr) => {
    // Tolerate a single trailing slash but nothing else empty.
    if (s === "") return i === arr.length - 1 ? false : true;
    return true;
  });

  if (segments.length === 0) {
    throw new Error(`Invalid repo path: "${filePath}" (empty)`);
  }

  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid repo path: "${filePath}" (path traversal or empty segment)`);
    }
    if (segment.includes("\\")) {
      throw new Error(`Invalid repo path: "${filePath}" (backslash)`);
    }
  }

  return segments.map(encodeURIComponent).join("/");
}

// ── Types ──

export interface GitHubFileResponse {
  sha: string;
  content: string;
}

interface GitHubApiResult<T> {
  ok: boolean;
  data: T | null;
  status: number;
}

// ── Low-level helpers ──

function authHeaders(token: string): Record<string, string> {
  return { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` };
}

export async function githubGet<T = unknown>(
  token: string,
  repo: string,
  filePath: string,
): Promise<GitHubApiResult<T>> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${encodeRepoPath(filePath)}?ref=main`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404) return { ok: false, data: null, status: 404 };
  const data = (await res.json()) as T;
  return { ok: res.ok, data, status: res.status };
}

export async function githubPut(
  token: string,
  repo: string,
  filePath: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  const body: Record<string, string> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch: "main",
  };
  if (sha) body["sha"] = sha;

  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${encodeRepoPath(filePath)}`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub PUT ${filePath}: HTTP ${res.status} — ${errText}`);
  }
}

export async function githubDelete(
  token: string,
  repo: string,
  filePath: string,
  sha: string,
  message: string,
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${encodeRepoPath(filePath)}`,
    {
      method: "DELETE",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha, branch: "main" }),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub DELETE ${filePath}: HTTP ${res.status} — ${errText}`);
  }
}

/** Account deletion waits at most this long for GitHub before deleting anyway. */
export const GITHUB_REVOKE_TIMEOUT_MS = 5000;

/**
 * Revoke the user's authorization of this OAuth app, which invalidates every
 * token GitHub issued to it for that user. Same effect as the user revoking xkg
 * under GitHub → Settings → Applications. Authenticated as the app itself.
 *
 * Returns whether GitHub confirmed it, which only a 204 does: a 404 can mean
 * the stored token is stale while another token for the same grant still
 * works. Throws when GitHub does not answer within the timeout.
 */
export async function revokeGithubGrant(
  clientId: string,
  clientSecret: string,
  token: string,
): Promise<boolean> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(clientId)}/grant`, {
    method: "DELETE",
    headers: { ...GITHUB_HEADERS, Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(GITHUB_REVOKE_TIMEOUT_MS),
  });
  return res.status === 204;
}

/** Settings waits at most this long for GitHub to name the knowledge repo. */
export const GITHUB_REPO_LOOKUP_TIMEOUT_MS = 3000;

/**
 * The repo's current `owner/name` as GitHub reports it. After a rename GitHub
 * redirects the old name, and `full_name` in the answer is the new one. Returns
 * null when GitHub can't be reached or answers with an error.
 */
export async function currentRepoName(token: string, repo: string): Promise<string | null> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REPO_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { full_name?: unknown };
    return typeof data.full_name === "string" && data.full_name.includes("/") ? data.full_name : null;
  } catch {
    return null;
  }
}

// ── High-level helpers ──

/** Read a file's decoded UTF-8 content and sha from a repo. */
export async function readFile(
  token: string,
  repo: string,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  const res = await githubGet<GitHubFileResponse>(token, repo, filePath);
  if (!res.ok || !res.data) return null;
  const decoded = Buffer.from(res.data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return { content: decoded, sha: res.data.sha };
}

/** GitHub answered a read with an error other than 404 (rate limit, revoked token, outage). */
export class GitHubReadError extends Error {
  constructor(readonly path: string, readonly status: number | undefined) {
    super(`GitHub read of ${path} failed (HTTP ${status ?? "?"})`);
    this.name = "GitHubReadError";
  }
}

/**
 * Like readFile, but null means only that the file doesn't exist; any other
 * failed read throws GitHubReadError, so a GitHub outage isn't shown as an
 * empty repo.
 */
export async function readFileStrict(
  token: string,
  repo: string,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  const res = await githubGet<GitHubFileResponse>(token, repo, filePath);
  if (res.status === 404) return null;
  if (!res.ok || !res.data) throw new GitHubReadError(filePath, res.status);
  const decoded = Buffer.from(res.data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return { content: decoded, sha: res.data.sha };
}

/** Append a row to INDEX.md, creating it if it doesn't exist. */
export async function appendToIndex(
  token: string,
  repo: string,
  row: string,
  commitMessage: string,
): Promise<void> {
  const existing = await readFile(token, repo, "INDEX.md");

  if (existing) {
    await githubPut(token, repo, "INDEX.md", existing.content + row, commitMessage, existing.sha);
  } else {
    const header =
      "# Knowledge Hub — Master Index\n\n| Date | Resource | Keywords | Tags |\n|------|----------|----------|------|\n";
    await githubPut(token, repo, "INDEX.md", header + row, "capture: initialize index");
  }
}

/** Update or remove an entry in INDEX.md when a capture is moved or deleted. */
export async function updateIndexEntry(
  token: string,
  repo: string,
  filename: string,
  action: "apply" | "archive" | "delete",
): Promise<void> {
  const existing = await readFile(token, repo, "INDEX.md");
  if (!existing) return;

  let updated: string;
  if (action === "delete") {
    updated = existing.content
      .split("\n")
      .filter((line) => !line.includes(filename))
      .join("\n");
  } else {
    const target = action === "apply" ? "applied" : "archived";
    updated = existing.content.replace(`inbox/${filename}`, `${target}/${filename}`);
  }

  await githubPut(token, repo, "INDEX.md", updated, `${action}: update index for ${filename}`, existing.sha);
}
