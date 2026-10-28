import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const APP = "https://xkg.xmu.sh";

function visit(path: string, session = false) {
  const headers: Record<string, string> = { "x-forwarded-host": "xkg.xmu.sh", "x-forwarded-proto": "https" };
  if (session) headers.cookie = "xkg_session=placeholder";
  return middleware(new NextRequest(`${APP}${path}`, { headers }));
}

describe("middleware", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP;
  });

  it("serves the web app manifest without a session (browsers fetch it without cookies)", () => {
    const res = visit("/manifest.webmanifest");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("lets admin API calls reach the route, which checks the admin secret itself", () => {
    const res = visit("/api/admin/apply-stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still sends a signed-out visitor on a private page to /login", () => {
    expect(visit("/").headers.get("location")).toBe(`${APP}/login`);
  });

  it("lets a signed-in visitor through", () => {
    expect(visit("/", true).headers.get("location")).toBeNull();
  });
});
