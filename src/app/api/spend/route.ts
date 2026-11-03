import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getBudget, monthSpend, parseBudget, setBudget } from "@/lib/llm-spend";

const fail = (err: unknown, what: string) =>
  NextResponse.json({ error: `[spend] ${err instanceof Error ? err.message : what}` }, { status: 500 });

/** Settings → AI model: what xkg spent with the user's key this month (an estimate), and the optional monthly budget. */
export async function GET(): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const [month, budgetUsd] = await Promise.all([monthSpend(user.id), getBudget(user.id)]);
    return NextResponse.json({ month, budgetUsd });
  } catch (err) {
    return fail(err, "Failed to read spend");
  }
}

/** Saves the monthly budget ({ budgetUsd: number }), or clears it ({ budgetUsd: null }). A warning only. */
export async function PUT(req: Request): Promise<NextResponse> {
  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    const body: unknown = await req.json().catch(() => null);
    // Only an explicit { budgetUsd: null } clears; a missing or malformed body is refused.
    const hasField = typeof body === "object" && body !== null && "budgetUsd" in body;
    const parsed = hasField ? parseBudget((body as { budgetUsd: unknown }).budgetUsd) : ({ ok: false } as const);
    if (!parsed.ok) {
      return NextResponse.json({ error: "Enter a monthly budget between $0.01 and $10,000, or leave it empty." }, { status: 400 });
    }
    await setBudget(user.id, parsed.value);
    return NextResponse.json({ budgetUsd: parsed.value });
  } catch (err) {
    return fail(err, "Failed to save the budget");
  }
}
