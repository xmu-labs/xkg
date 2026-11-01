/**
 * For each provider, measure a few fast listed models and one reasoning model
 * on the same sources: extraction time, and how many fields keep a checked
 * quote. The fastest model whose coverage stays within COVERAGE_SLACK of the
 * reasoning model's becomes the row the faster-model hint quotes
 * (src/lib/model-speed.json). Run by hand; never in CI. See CONTRIBUTING.md.
 *
 *   npx tsx scripts/measure-model-speed.ts --sources <dir> [--out src/lib/model-speed.json]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractCapture } from "../src/lib/llm";
import { fetchSourceContent } from "../src/lib/fetch-source";
import { PROVIDERS } from "../src/lib/providers";
import { KEY_ENV, parseMeasureArgs, type MeasureProvider } from "../src/lib/measure-speed-args";
import type { ModelSpeedRow } from "../src/lib/model-speed";
import { COVERAGE_SLACK } from "../src/lib/model-nudge";

/** Fast models worth suggesting; each must stay in PROVIDERS[provider].models. */
const FAST_CANDIDATES: Record<MeasureProvider, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4.1"],
  anthropic: ["claude-haiku-4-5", "claude-haiku-5-5"],
  google: ["gemini-2.0-flash", "gemini-2.5-flash"],
};

/** The reasoning model each provider is compared against. */
const SLOW_MODEL: Record<MeasureProvider, string> = {
  openai: "gpt-6.1-terra",
  anthropic: "claude-sonnet-5-5",
  google: "gemini-2.5-pro",
};

/** A provider whose recommended model fails more often than this keeps its old row. */
const MAX_FAILURE_SHARE = 0.2;
const CONCURRENCY = 3;

type Source = { id: string; text: string; url?: string };
type Run = { ok: true; ms: number; kept: number; fields: number } | { ok: false; error: string };

const log = (line: string) => process.stdout.write(`${line}\n`);
const warn = (line: string) => process.stderr.write(`measure-model-speed: ${line}\n`);

async function loadSources(dir: string): Promise<Source[]> {
  if (!existsSync(dir)) {
    warn(`no folder at ${dir}. Pass --sources with a folder of .txt and .url files.`);
    process.exit(2);
  }
  const sources: Source[] = [];
  for (const name of readdirSync(dir).sort()) {
    const body = readFileSync(join(dir, name), "utf8").trim();
    if (name.endsWith(".txt") && body) sources.push({ id: name, text: body });
    if (name.endsWith(".url") && body) {
      const page = await fetchSourceContent(body);
      if (page) sources.push({ id: name, text: page, url: body });
      else warn(`couldn't read ${body} (${name}); skipped.`);
    }
  }
  return sources;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

async function measure(provider: MeasureProvider, model: string, key: string, sources: Source[], runs: number, verbose: boolean): Promise<Run[]> {
  const jobs = sources.flatMap((s) => Array.from({ length: runs }, () => s));
  return pool(jobs, CONCURRENCY, async (s): Promise<Run> => {
    const started = Date.now();
    try {
      const c = await extractCapture(key, s.text, undefined, { provider, model, effort: null }, { url: s.url });
      return { ok: true, ms: Date.now() - started, kept: c.stats?.claimsKept ?? 0, fields: c.stats?.fieldsTotal ?? 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (verbose) warn(`${provider} ${model} on ${s.id}: ${message}`);
      return { ok: false, error: message.slice(0, 80) };
    }
  });
}

function coverage(runs: Run[]): number {
  const ok = runs.filter((r): r is Extract<Run, { ok: true }> => r.ok);
  const fields = ok.reduce((n, r) => n + r.fields, 0);
  return fields === 0 ? 0 : Math.round((ok.reduce((n, r) => n + r.kept, 0) / fields) * 100) / 100;
}

async function main(): Promise<void> {
  const args = parseMeasureArgs(process.argv.slice(2), process.env);
  if (!args.ok) {
    (args.exit === 0 ? log : (l: string) => process.stderr.write(`${l}\n`))(args.message);
    process.exit(args.exit);
  }
  const { opts } = args;
  const sources = await loadSources(opts.sources);
  if (sources.length === 0) {
    warn(`no readable sources in ${opts.sources}.`);
    process.exit(2);
  }
  const calls = sources.length * opts.runs * opts.providers.reduce((n, p) => n + 1 + FAST_CANDIDATES[p].length, 0);
  log(`${sources.length} sources, ${opts.runs} run(s) each, ${opts.providers.join(", ")}: about ${calls} model calls, billed to your keys.`);
  if (calls > 100 && !opts.yes) {
    warn(`that is more than 100 calls. Pass --yes to run them, or fewer --runs or --providers.`);
    process.exit(2);
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows: ModelSpeedRow[] = [];
  let failed = false;
  for (const provider of opts.providers) {
    const key = process.env[KEY_ENV[provider]]!;
    const slowModel = SLOW_MODEL[provider];
    const summarize = (model: string, runs: Run[]) => {
      const ok = runs.filter((r): r is Extract<Run, { ok: true }> => r.ok);
      const firstError = runs.find((r): r is Extract<Run, { ok: false }> => !r.ok)?.error ?? "no result";
      const usable = ok.length > 0 && (runs.length - ok.length) / runs.length <= MAX_FAILURE_SHARE;
      const meanMs = ok.length ? Math.round(ok.reduce((n, r) => n + r.ms, 0) / ok.length) : 0;
      log(`${provider} ${model}: ${usable ? `${(meanMs / 1000).toFixed(1)} s, quotes ${coverage(runs)}` : "unusable"}, ${runs.length - ok.length} of ${runs.length} failed${usable ? "" : ` (${firstError})`}`);
      return { model, usable, meanMs, coverage: coverage(runs) };
    };
    const slow = summarize(slowModel, await measure(provider, slowModel, key, sources, opts.runs, opts.verbose));
    if (!slow.usable) {
      warn(`${provider} ${slowModel} failed too often, so there is nothing to compare quotes against. Its old row is kept; re-run with --providers ${provider}${opts.verbose ? "" : " --verbose"}.`);
      failed = true;
      continue;
    }
    const candidates = [];
    for (const model of FAST_CANDIDATES[provider].filter((m) => PROVIDERS[provider].models.includes(m))) {
      candidates.push(summarize(model, await measure(provider, model, key, sources, opts.runs, opts.verbose)));
    }
    const best = candidates
      .filter((c) => c.usable && c.coverage >= slow.coverage - COVERAGE_SLACK)
      .sort((a, b) => a.meanMs - b.meanMs)[0];
    if (!best) {
      warn(`${provider}: no fast model keeps the checked quotes within ${COVERAGE_SLACK} of ${slowModel}. Its old row is kept.`);
      failed = true;
      continue;
    }
    log(`${provider}: suggest ${best.model}`);
    rows.push({
      provider, fastModel: best.model, fastMeanMs: best.meanMs, coverageFast: best.coverage,
      slowModel, slowMeanMs: slow.meanMs, coverageSlow: slow.coverage, sources: sources.length, measuredOn: today,
    });
  }

  if (opts.out) {
    const old: ModelSpeedRow[] = existsSync(opts.out) ? JSON.parse(readFileSync(opts.out, "utf8")) : [];
    const merged = [...old.filter((r) => !rows.some((n) => n.provider === r.provider)), ...rows]
      .sort((a, b) => a.provider.localeCompare(b.provider));
    writeFileSync(opts.out, `${JSON.stringify(merged, null, 2)}\n`);
    log(`wrote ${rows.length} row(s) to ${opts.out}`);
  } else {
    log(JSON.stringify(rows, null, 2));
  }
  process.exit(failed ? 1 : 0);
}

void main();
