/**
 * MCP tool schemas: the wire contract advertised by `tools/list`.
 *
 * Kept apart from the handlers so the shape a client sees can be reviewed
 * without reading the implementations, and so route.ts stays transport-only.
 * Every connected agent loads this list into its context in every session, so
 * it is kept short: five tools for agent work, plus, until the web app has
 * them, the human actions. `ToolName` covers the listed tools and the hidden
 * names below, and lib/mcp/handlers keys its registry by that union, so a name
 * without a handler (or vice versa) is a compile error.
 */

/** The tools for agent work. */
export const CORE_TOOLS = [
  {
    name: "capture",
    description: "Save outside knowledge (an article, thread, notes or idea) to the user's xkg repo, with checked insights and where in their code it may apply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The content to capture" },
        title: { type: "string", description: "Optional title hint" },
      },
      required: ["content"],
    },
  },
  {
    name: "briefing",
    description: "Call at the start of a coding session, and mid-task with task. Returns captures that may fit as candidates: xkg has not seen the code, so check each one against the code before you suggest it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "owner/name of the origin remote. Captures waiting for it come first, with the question to ask the user." },
        project_context: { type: "string", description: "At session start: repo name, branch, last few commit messages" },
        task: { type: "string", description: "Mid-task: what you are doing now. Returns the best fits with scores." },
        files: { type: "array" as const, items: { type: "string" }, description: "Paths you are working on (names only, never code)" },
        exclude: { type: "array" as const, items: { type: "string" }, description: "Captures already shown this session" },
        limit: { type: "number", description: "With task: max captures (default 5, max 10)" },
        include_rules: { type: "boolean", description: "Add the user's rules (default true at session start, false with task)" },
      },
    },
  },
  {
    name: "search",
    description: "Find captures by words, tag, status or date, or list them all (omit query). Words are OR-matched and ranked. The footer gives the total and the next offset.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search words; omit to list all" },
        tag: { type: "string", description: "Only captures with this tag" },
        status: { type: "string", enum: ["inbox", "applied", "archived"], description: "Only captures in this folder" },
        since: { type: "string", description: "On or after this date (YYYY-MM-DD)" },
        until: { type: "string", description: "On or before this date (YYYY-MM-DD)" },
        offset: { type: "number", description: "Matches to skip" },
        limit: { type: "number", description: "Max matches (default 20, max 50)" },
      },
    },
  },
  {
    name: "read_capture",
    description: "Read a capture in full, by a filename from briefing or search. Without a folder, inbox/ is assumed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "e.g. '2026-04-02-slug.md' or 'applied/2026-04-02-slug.md'" },
      },
      required: ["filename"],
    },
  },
  {
    name: "apply_capture",
    description: "Record that a commit applied a capture, or the user's answer to a handoff. Call it right after the commit, with the sha and the repo. If the user turned the capture down, pass outcome declined (with a reason), done or later: the capture stays put, and a declined capture never counts as an apply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Capture filename; an inbox/ or applied/ prefix is accepted" },
        commit_sha: { type: "string", description: "The commit that applied it (git rev-parse HEAD); with reverted, the reverted commit" },
        repo: { type: "string", description: "The code repo as owner/name; says which handoff this answers" },
        applied_note: { type: "string", description: "Why it applied here and what you did, in one line of up to 200 characters" },
        target_file: { type: "string", description: "Main file changed" },
        files: { type: "array", items: { type: "string" }, description: "Paths you changed, relative to the repo root" },
        outcome: { type: "string", description: "applied (default), declined, done (already done), later (offered again in 7 days) or reverted" },
        reason: { type: "string", enum: ["wrong-files", "doesnt-fit", "other"], description: "With declined: it fits but not in those files, it doesn't fit this repo, or other" },
        confidence: { type: "string", enum: ["high", "medium", "low"], description: "From the spec's Confidence line" },
        plan_file: { type: "string", description: "Plan that drove it, if any" },
      },
      required: ["filename"],
    },
  },
] as const;

/**
 * Human decisions and reports. Listed until the web app has them, then
 * unlisted like the names in LEGACY_TOOL_NAMES.
 */
export const HUMAN_TOOLS = [
  {
    name: "archive_capture",
    description: "Archive a capture — reviewed but not actionable now. Moves from inbox/ to archived/ and updates the index.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename in inbox (e.g. '2026-04-02-some-slug.md')" },
      },
      required: ["filename"],
    },
  },  {
    name: "delete_capture",
    description: "Permanently delete a capture and remove its index entry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename in inbox (e.g. '2026-04-02-some-slug.md')" },
      },
      required: ["filename"],
    },
  },  {
    name: "curate",
    description: "Validate knowledge captures: check for stale URLs (404/410), flag low-confidence extractions, and optionally auto-archive stale ones. Returns a curation report.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Single inbox file to curate (e.g. '2026-05-14-slug.md'). Omit to curate the entire inbox." },
        auto_archive: { type: "boolean", description: "If true, automatically archive captures flagged as stale or low-confidence (default false)" },
        since: { type: "string", description: "Only curate captures dated on/after this date (inclusive, 'YYYY-MM-DD')" },
        until: { type: "string", description: "Only curate captures dated on/before this date (inclusive, 'YYYY-MM-DD')" },
        offset: { type: "number", description: "Number of files to skip for pagination (default 0)" },
        limit: { type: "number", description: "Max files to check in one call (default 20, max 50)" },
      },
    },
  },  {
    name: "synthesize",
    description: "Synthesize accumulated knowledge on a topic into actionable rules. Updates RULES.md in your knowledge repo. Can target a specific tag or synthesize all knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tag: { type: "string", description: "Tag to synthesize (e.g. 'product-discovery'). Required." },
      },
      required: ["tag"],
    },
  },  {
    name: "apply_stats",
    description: "Show how many captures were applied per week, and how many of those came with a commit. Reads the APPLIED.md ledger that apply_capture writes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        weeks: { type: "number", description: "How many recent weeks to show (1 to 52, default 4)" },
      },
    },
  },] as const;

/** What `tools/list` returns. */
export const TOOLS = [...CORE_TOOLS, ...HUMAN_TOOLS] as const;

/**
 * Names merged into the listed tools. Not listed, but still answered, because
 * published CLIs and installed hooks call them: search_captures and list_inbox
 * are `search`; recall, vault_scan, apply_to_context and get_rules are
 * `briefing`; generate_plan and list_plans gave way to handoffs. Remove them
 * two CLI releases after the CLI stopped calling them.
 */
export const LEGACY_TOOL_NAMES = [
  "search_captures",
  "list_inbox",
  "recall",
  "vault_scan",
  "apply_to_context",
  "get_rules",
  "generate_plan",
  "list_plans",
] as const;

export type ToolName = (typeof TOOLS)[number]["name"] | (typeof LEGACY_TOOL_NAMES)[number];
