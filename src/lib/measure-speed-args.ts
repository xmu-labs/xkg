/**
 * Arguments for scripts/measure-model-speed.ts, checked before any paid call.
 * Keys come from the environment; only the variable names are ever printed.
 */

export const MEASURE_PROVIDERS = ["openai", "anthropic", "google"] as const;
export type MeasureProvider = (typeof MEASURE_PROVIDERS)[number];

export const KEY_ENV: Record<MeasureProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
};

export interface MeasureOptions {
  sources: string;
  providers: MeasureProvider[];
  out: string | null;
  runs: number;
  verbose: boolean;
  yes: boolean;
}

export type MeasureArgs = { ok: true; opts: MeasureOptions } | { ok: false; exit: 0 | 2; message: string };

export const MEASURE_HELP = `Measure how fast each provider's recommended model extracts a capture.

Usage: npx tsx scripts/measure-model-speed.ts --sources <dir> [options]

  --sources <dir>      Folder of sources: one .txt file per pasted text, or a .url file holding one link.
  --providers <list>   Comma-separated: openai, anthropic, google. Default: every provider with a key set.
  --out <file>         Write the measured rows into this JSON file (src/lib/model-speed.json). Default: print them.
  --runs <n>           Times to run each source on each model, 1 to 10. Default: 1.
  --verbose            Print each provider error in full.
  --yes                Run even when it makes more than 100 model calls.
  --help               Show this help.

Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY. The calls are billed to these keys.
Exit codes: 0 done, 1 a provider failed (its old row is kept), 2 usage error.`;

export function parseMeasureArgs(argv: string[], env: Record<string, string | undefined>): MeasureArgs {
  const fail = (message: string): MeasureArgs => ({ ok: false, exit: 2, message: `measure-model-speed: ${message}` });
  let sources: string | null = null;
  let providerList: string | null = null;
  let out: string | null = null;
  let runs = 1;
  let verbose = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    switch (arg) {
      case "--help":
      case "-h":
        return { ok: false, exit: 0, message: MEASURE_HELP };
      case "--sources": sources = value() ?? null; break;
      case "--providers": providerList = value() ?? null; break;
      case "--out": out = value() ?? null; break;
      case "--runs": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 10) return fail("--runs must be a whole number from 1 to 10.");
        runs = n;
        break;
      }
      case "--verbose": verbose = true; break;
      case "--yes": yes = true; break;
      default:
        return fail(`Unknown option "${arg}". Run with --help to see the options.`);
    }
  }

  if (!sources) return fail("pass --sources <dir>, a folder of .txt and .url sources. Run with --help for details.");

  const hasKey = (p: MeasureProvider) => Boolean(env[KEY_ENV[p]]);
  let providers: MeasureProvider[];
  if (providerList) {
    providers = [];
    for (const name of providerList.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!MEASURE_PROVIDERS.includes(name as MeasureProvider)) {
        return fail(`Unknown provider "${name}". Use ${MEASURE_PROVIDERS.join(", ")}.`);
      }
      providers.push(name as MeasureProvider);
    }
    const missing = providers.find((p) => !hasKey(p));
    if (missing) {
      const rest = providers.filter((p) => p !== missing);
      const skip = rest.length > 0 ? `pass --providers ${rest.join(",")} to skip it` : "measure another provider";
      return fail(`no key for ${missing} (${KEY_ENV[missing]} is unset). Export it, or ${skip}.`);
    }
  } else {
    providers = MEASURE_PROVIDERS.filter(hasKey);
    if (providers.length === 0) {
      return fail("no provider key set. Export OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY.");
    }
  }

  return { ok: true, opts: { sources, providers, out, runs, verbose, yes } };
}
