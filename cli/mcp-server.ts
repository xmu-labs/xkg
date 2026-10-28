// MCP server that runs locally via stdio and proxies to the hosted API.
// Used by Claude Code: claude mcp add xkg -- npx @xmu-labs/xkg serve-mcp --key <api-key>

const DEFAULT_HOSTED_URL = "https://xkg.xmu.sh/api/mcp";

/** Override for pointing the proxy at a local instance during development. */
const HOSTED_URL =
  process.env.XKG_API_URL ?? process.env.XMU_API_URL ?? process.env.MNEMOS_API_URL ?? DEFAULT_HOSTED_URL;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function sendMessage(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** In-flight proxied requests, so shutdown can wait for them. */
const pending = new Set<Promise<void>>();

function rpcError(id: JsonRpcMessage["id"], message: string): void {
  sendMessage({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

async function proxyToHosted(hosted: ReturnType<typeof createHostedSession>, msg: JsonRpcMessage): Promise<void> {
  const result = await hosted.send(msg);
  if ("error" in result) {
    rpcError(msg.id, result.error);
    return;
  }
  sendMessage(result.data);
}

/**
 * Turn a raw HTTP reply into either parsed JSON-RPC data or a useful message.
 *
 * Parsing straight to JSON turns any non-JSON reply — an HTML error page from a
 * 500, a proxy block page, a login redirect — into "Unexpected token '<'",
 * which says nothing about what actually happened. Reporting the status and a
 * snippet makes the real cause visible in the MCP client.
 *
 * Exported for testing; this is the logic worth covering, not the stdio plumbing.
 */
export function interpretResponse(
  status: number,
  contentType: string | null,
  body: string,
): { data: Record<string, unknown> } | { error: string } {
  const type = contentType ?? "";

  if (!type.includes("application/json")) {
    const snippet = body.trim().slice(0, 200).replace(/\s+/g, " ");
    return {
      error: `xkg returned a non-JSON response (HTTP ${status}${
        type ? `, ${type}` : ""
      })${snippet ? `: ${snippet}` : ""}`,
    };
  }

  try {
    return { data: JSON.parse(body) as Record<string, unknown> };
  } catch {
    return { error: `xkg returned malformed JSON (HTTP ${status}).` };
  }
}

type HostedReply = { data: Record<string, unknown> } | { error: string };

/**
 * The connection to the hosted server. It keeps the Mcp-Session-Id that
 * `initialize` returns and sends it on every later call, so the server knows
 * which agent is calling. When the session expires (404), it replays the
 * client's `initialize` for a new one and retries the call once.
 */
export function createHostedSession(apiKey: string, url: string, fetchFn: typeof fetch = fetch) {
  let sessionId: string | null = null;
  let initializeMsg: JsonRpcMessage | null = null;

  async function post(msg: JsonRpcMessage): Promise<HostedReply & { status?: number }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (sessionId && msg.method !== "initialize") headers["Mcp-Session-Id"] = sessionId;
    let res: Response;
    try {
      res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(msg) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      return { error: `Could not reach xkg at ${url}: ${detail}` };
    }
    if (msg.method === "initialize") sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    const body = await res.text().catch(() => "");
    return { ...interpretResponse(res.status, res.headers.get("content-type"), body), status: res.status };
  }

  return {
    async send(msg: JsonRpcMessage): Promise<HostedReply> {
      if (msg.method === "initialize") initializeMsg = msg;
      const hadSession = sessionId !== null && msg.method !== "initialize";
      let { status, ...reply } = await post(msg);
      if (status === 404 && hadSession && initializeMsg) {
        sessionId = null;
        await post(initializeMsg);
        ({ status, ...reply } = await post(msg));
      }
      return reply;
    },
  };
}

/** Track a proxied request so shutdown can await it. */
function track(p: Promise<void>): void {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

export async function serveMcp(): Promise<void> {
  // Parse --key flag
  const args = process.argv.slice(2);
  const keyIdx = args.indexOf("--key");
  const apiKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined;

  if (!apiKey) {
    process.stderr.write("\nxkg MCP server requires an API key.\n");
    process.stderr.write("Usage: npx -y @xmu-labs/xkg@latest serve-mcp --key <your-api-key>\n\n");
    process.stderr.write("Get your API key at: https://xkg.xmu.sh/onboard\n\n");
    process.exit(1);
  }

  // Self-upgrade: if a newer version exists on npm, respawn via npx @latest.
  // Handled before anything else so stdio isn't yet owned by the MCP loop.
  try {
    const { maybeSelfUpgrade } = await import("./version-check.js");
    const upgrading = await maybeSelfUpgrade();
    if (upgrading) return; // child has taken over; parent will exit when child does
  } catch {
    // Version check must never block startup
  }

  // Auto-install the inbox hook the first time the MCP server is registered.
  // Uses silent mode so it never prints to stdout (which is reserved for MCP protocol).
  try {
    const { setupHooks } = await import("./hooks.js");
    setupHooks(apiKey, { silent: true, skipIfExists: true });
  } catch {
    // Non-fatal — hook setup should never block the MCP server from starting
  }

  process.stderr.write("xkg MCP server starting (proxying to hosted instance)...\n");

  const hosted = createHostedSession(apiKey, HOSTED_URL);
  let buffer = "";
  process.stdin.setEncoding("utf-8");

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcMessage;

        // Handle notifications/initialized locally (no response needed)
        if (msg.method === "notifications/initialized") continue;

        track(proxyToHosted(hosted, msg));
      } catch {
        process.stderr.write(`Failed to parse: ${line}\n`);
      }
    }
  });

  // Wait for in-flight requests before exiting: exiting immediately on stdin
  // close discards responses that were still being fetched, so the client sees
  // silence rather than an answer or an error.
  process.stdin.on("end", () => {
    void Promise.allSettled([...pending]).then(() => process.exit(0));
  });
}
