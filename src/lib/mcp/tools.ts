/**
 * MCP tool schemas — the wire contract advertised by `tools/list`.
 *
 * Kept apart from the handlers so the shape a client sees can be reviewed
 * without reading the implementations, and so route.ts stays transport-only.
 * The names here are the single source of truth: `ToolName` is derived from
 * this array, and lib/mcp/handlers keys its registry by that union, so a tool
 * added here without a handler (or vice versa) is a compile error.
 */

export const TOOLS = [
  {
    name: "capture",
    description:
      "Capture a resource (article, thread, notes, transcript) into the knowledge hub. Extracts insights, tags them, and commits to the knowledge repo.",
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
    name: "search_captures",
    description: "Search the knowledge hub for captures. The query is tokenized on whitespace and matched with OR semantics (a capture surfaces if it contains any term), ranked by how many terms it matches, with a bonus for an exact phrase match — so a single unknown word no longer zeroes the whole query. Omit query (or pass an empty string) to list ALL captures. Supports tag/date filtering and offset/limit pagination; the response footer reports the total and next offset.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search terms (whitespace-separated, OR-matched). Omit or leave empty to list all captures." },
        tag: { type: "string", description: "Filter by tag (e.g. 'ai-agents', 'pricing')" },
        since: { type: "string", description: "Only include captures dated on/after this date (inclusive, 'YYYY-MM-DD')" },
        until: { type: "string", description: "Only include captures dated on/before this date (inclusive, 'YYYY-MM-DD')" },
        offset: { type: "number", description: "Number of matches to skip for pagination (default 0)" },
        limit: { type: "number", description: "Max matches to return (default 20, max 50)" },
      },
    },
  },
  {
    name: "list_inbox",
    description: "List unprocessed captures in the inbox with summaries (title, type, tags, core idea). Supports date filtering and pagination — page through the entire inbox with offset/limit; the response footer reports the total and the next offset.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: { type: "string", description: "Only include captures dated on/after this date (inclusive, 'YYYY-MM-DD')" },
        until: { type: "string", description: "Only include captures dated on/before this date (inclusive, 'YYYY-MM-DD')" },
        offset: { type: "number", description: "Number of captures to skip for pagination (default 0)" },
        limit: { type: "number", description: "Max captures to summarize (default 10, max 50)" },
      },
    },
  },
  {
    name: "read_capture",
    description: "Read the full content of a capture from the knowledge repo. Defaults to inbox/ if no path prefix given.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename (e.g. '2026-04-02-some-slug.md') or full path (e.g. 'applied/2026-04-02-some-slug.md')" },
      },
      required: ["filename"],
    },
  },
  {
    name: "apply_capture",
    description: "Mark a capture as applied. Call it right after you commit a change that applies a capture, with the commit sha. Records how and where the knowledge was used. The first time, moves the capture from inbox/ to applied/, updates status and index, and triggers rule re-synthesis; calling it for an already-applied capture adds another application log entry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Capture filename (e.g. '2026-04-02-some-slug.md'); an 'inbox/' or 'applied/' prefix is accepted" },
        commit_sha: { type: "string", description: "Sha of the commit that applied the capture (from `git rev-parse HEAD`). Links the insight to the code change it caused." },
        applied_note: { type: "string", description: "Why this capture applied here and what you did, in one line of up to 200 characters (e.g. 'Retries hid a timeout bug, so added the capture's backoff rule to the API client')" },
        target_file: { type: "string", description: "File path where the knowledge was applied (e.g. 'docs/conventions.md', 'src/utils/pricing.ts')" },
        outcome: { type: "string", description: "What changed as a result (e.g. 'Reduced error rate by rewriting retry logic per capture advice')" },
        plan_file: { type: "string", description: "Optional plan filename that drove this application (e.g. 'plans/2026-06-04-plan-slug.md') — creates an audit trail linking captures to plans" },
      },
      required: ["filename"],
    },
  },
  {
    name: "apply_stats",
    description: "Show how many captures were applied per week, and how many of those came with a commit. Reads the APPLIED.md ledger that apply_capture writes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        weeks: { type: "number", description: "How many recent weeks to show (1 to 52, default 4)" },
      },
    },
  },
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
  },
  {
    name: "delete_capture",
    description: "Permanently delete a capture and remove its index entry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename in inbox (e.g. '2026-04-02-some-slug.md')" },
      },
      required: ["filename"],
    },
  },
  {
    name: "recall",
    description: "Describe your current task or problem, and get back the most relevant knowledge from your capture library. More powerful than keyword search — understands semantic relevance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        context: { type: "string", description: "What you're working on or thinking about (1-3 sentences)" },
        max_results: { type: "number", description: "Max captures to return (default 5, max 10)" },
      },
      required: ["context"],
    },
  },
  {
    name: "synthesize",
    description: "Synthesize accumulated knowledge on a topic into actionable rules. Updates RULES.md in your knowledge repo. Can target a specific tag or synthesize all knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tag: { type: "string", description: "Tag to synthesize (e.g. 'product-discovery'). Required." },
      },
      required: ["tag"],
    },
  },
  {
    name: "get_rules",
    description: "Get the synthesized knowledge rules file. Use to populate project guidance or a system prompt with accumulated knowledge. Returns RULES.md content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tag: { type: "string", description: "Filter to rules for a specific tag/topic. Omit for all rules." },
      },
    },
  },
  {
    name: "briefing",
    description: "Call at the start of a coding session: returns up to 5 captures that may fit the current project, plus the user's rules. xkg has not seen the code, so these are candidates: check each one against the code before you suggest it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_context: { type: "string", description: "Describe the project you're working on (tech stack, domain, current focus area)" },
        include_rules: { type: "boolean", description: "Include synthesized rules in the briefing (default true)" },
        repo: { type: "string", description: "The repo's owner/name from its origin remote. Captures waiting for this repo come first, with the question to ask the user. With repo and no project_context, only those are returned." },
      },
    },
  },
  {
    name: "apply_to_context",
    description: "Describe your current task, stack, and optionally paste code — get back concrete, code-level suggestions for applying captured knowledge. Translates insights into specific guidance for your codebase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string", description: "What you're building or fixing" },
        stack: { type: "string", description: "Tech stack (e.g. 'Next.js, TypeScript, Stripe')" },
        files: {
          type: "array" as const,
          items: { type: "string" },
          description: "File paths you're working on (e.g. ['src/api/payments.ts'])",
        },
        code_snippet: { type: "string", description: "Relevant code snippet for targeted suggestions" },
      },
      required: ["task"],
    },
  },
  {
    name: "generate_plan",
    description: "Generate a structured implementation plan from selected knowledge captures. Reads full capture content and produces a Markdown plan saved to plans/ in your knowledge repo. xkg never sees your code, so check each step against the files before applying it. Use after briefing to turn insights into actionable steps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selected_captures: {
          type: "array" as const,
          items: { type: "string" },
          description: "Filenames of captures to include (e.g. ['inbox/2026-05-14-slug.md', 'applied/2026-04-02-slug.md'])",
        },
        project_context: { type: "string", description: "Description of current project context (branch, what you're working on)" },
        codebase_files: {
          type: "array" as const,
          items: { type: "string" },
          description: "Optional: up to 5 repo-relative paths of files the plan should cover (e.g. ['src/app/api/capture/route.ts']). Paths only: xkg never reads code, so don't send file contents.",
        },
      },
      required: ["selected_captures", "project_context"],
    },
  },
  {
    name: "list_plans",
    description: "List saved implementation plans, or read a specific plan in full. Plans are generated by generate_plan and saved to the plans/ folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Optional plan filename to read in full (e.g. '2026-06-04-plan-slug.md')" },
      },
    },
  },
  {
    name: "vault_scan",
    description: "Scan the full knowledge vault for captures relevant to your current activity. Searches inbox, applied, and archived captures. Returns matches with score >= 0.7 not already surfaced this session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        activity_context: { type: "string", description: "What you're about to do — include the file path and operation (e.g. 'editing src/api/capture/route.ts to add error handling')" },
        session_surfaced: {
          type: "array" as const,
          items: { type: "string" },
          description: "Filenames already surfaced this session — excluded from results to avoid repetition",
        },
      },
      required: ["activity_context"],
    },
  },
  {
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
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
