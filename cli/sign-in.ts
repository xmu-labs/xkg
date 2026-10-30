/**
 * Sign in from the terminal through the browser (the server side is
 * src/lib/cli-login.ts): ask xkg for a code, open the approve page, and poll
 * until the user approves. The key that comes back belongs to this machine,
 * so signing in here never cuts off another machine.
 */

const BASE_URL = "https://xkg.xmu.sh";
const SLOW_DOWN_STEP_MS = 5000;

export interface SignInDeps {
  fetch: typeof fetch;
  /** Open a URL in the browser; may throw when there is none. */
  open: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** This machine's name, shown on the approve page. */
  label: string;
}

interface Started {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function post(deps: SignInDeps, path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await deps.fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export async function browserSignIn(deps: SignInDeps): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  let started: Started;
  try {
    const { status, data } = await post(deps, "/api/cli-login/start", { label: deps.label });
    if (status !== 200 || typeof data.device_code !== "string") {
      return { ok: false, reason: typeof data.error === "string" ? data.error : `xkg answered HTTP ${status}.` };
    }
    started = data as unknown as Started;
  } catch (err) {
    return { ok: false, reason: `Can't reach xkg: ${err instanceof Error ? err.message : String(err)}` };
  }

  deps.log(`Open ${started.verification_uri_complete}`);
  deps.log(`and check that it shows ${started.user_code}, then approve.`);
  try {
    deps.open(started.verification_uri_complete);
  } catch {
    // No browser here: the link above works from any device.
  }

  let interval = started.interval * 1000;
  let waited = 0;
  while (waited + interval <= started.expires_in * 1000) {
    await deps.sleep(interval);
    waited += interval;
    let data: Record<string, unknown>;
    try {
      ({ data } = await post(deps, "/api/cli-login/poll", { device_code: started.device_code }));
    } catch {
      continue; // A dropped connection: try again until the code expires.
    }
    if (data.status === "approved" && typeof data.api_key === "string") return { ok: true, key: data.api_key };
    if (data.status === "slow_down") interval += SLOW_DOWN_STEP_MS;
    else if (data.status === "denied") return { ok: false, reason: "Sign-in was denied in the browser." };
    else if (data.status === "expired") return { ok: false, reason: "The sign-in code expired." };
  }
  return { ok: false, reason: "The sign-in code expired." };
}
