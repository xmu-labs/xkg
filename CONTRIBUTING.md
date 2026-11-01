# Contributing to xkg

Thanks for looking. xkg is a small project with a large surface — an MCP server, a Next.js app, a
CLI, and OAuth — so this page is about how to change it safely rather than about process ceremony.

## Before you start

Open an issue first for anything beyond a bug fix or a doc correction. xkg holds people's GitHub
tokens and LLM API keys, so changes near auth, storage, or the MCP surface deserve a conversation
before the code exists.

Small, obviously-correct fixes — a typo, a broken link, a failing edge case with a test — go straight
to a PR.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting it running

You do not need to run xkg to use it — the hosted instance at [xkg.xmu.sh](https://xkg.xmu.sh) is the supported way in. This section is for working on the code.

| | |
| --- | --- |
| Node.js | 20.9 or later (Next.js 16 requires it) |
| PostgreSQL | any reachable instance — local, Neon, or Vercel Postgres |
| GitHub OAuth app | [create one](https://github.com/settings/developers) with callback `http://localhost:3000/api/auth/callback` |

```bash
git clone https://github.com/xmu-labs/xkg.git
cd xkg
npm ci
cp .env.example .env.local
```

| Variable | Where it comes from |
| --- | --- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | your GitHub OAuth app |
| `POSTGRES_URL` | your Postgres connection string |
| `SESSION_SECRET` | `openssl rand -hex 32` — also derives the credential-encryption key |
| `ADMIN_SECRET` | any random string; guards `/api/init-db` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` |

```bash
npm run dev
# in another shell, once — creates the tables (idempotent)
curl -X POST http://localhost:3000/api/init-db -H "x-admin-secret: $ADMIN_SECRET"
```

Sign in at `http://localhost:3000` with GitHub. **`init-db` must succeed before sign-in works.**

```bash
XKG_API_URL=http://localhost:3000/api/mcp node dist/cli/index.js serve-mcp --key <key>
```

**After any schema change**, `init-db` must run again. From GitHub: **Actions → Initialize database → Run workflow**.


## The checks

CI runs exactly two things, and so should you before pushing:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

`npm run test:e2e` runs the Playwright suite; it is not in CI and is optional.

A green Vercel preview means the app *built*. It does not mean the code is correct — that is what the
two commands above are for.

## Measuring the fast model

The faster-model offer after a slow capture quotes `src/lib/model-speed.json`. To refresh it (when a provider's model list changes, or every few months; rows older than 90 days are ignored):

```bash
export OPENAI_API_KEY=...        # also ANTHROPIC_API_KEY, GEMINI_API_KEY for those providers
npx tsx scripts/measure-model-speed.ts --sources <dir> --runs 2 --out src/lib/model-speed.json
```

- `<dir>` holds one `.txt` file per pasted text, or a `.url` file with one link (fetched at run time). Keep it outside the repo: use public articles or made-up text, never your own captures.
- The calls are billed to your keys: about sources × runs × 3 calls per provider. It asks for `--yes` above 100 calls.
- It never runs in CI. Exit codes: 0 done, 1 a provider failed (its old row is kept), 2 usage error. `--help` lists every option.
- Commit the JSON with the script's summary lines in the PR description.

## What good looks like here

**Comments explain why, not what.** The codebase leans on this heavily, especially around security
decisions. If a reader would reasonably ask "why is it done this way?", answer it in the code.

**Pure logic goes in `src/lib/` and gets unit-tested.** Route handlers are hard to test, so the
testable part is extracted — see `paginate`, `matchIndexRows`, `verifyPin`, `encodeRepoPath`. Follow
that pattern rather than adding logic inside a route.

**API routes must always return JSON.** Never let an exception escape a handler: Next.js answers with
an HTML error page, and the client's `res.json()` then fails with a cryptic browser-engine error.
`req.json()` belongs inside its own try/catch — enforced by `route-json-guards.test.ts`.

**Agent instructions live in `src/lib/mcp/instructions.ts`.** Every connected agent gets that text in
its system prompt, so keep it short and name only real tools and CLI commands. `mcp-instructions.test.ts`
checks both; update it in the same PR as the text.

**Tag errors with their source.** `[capture] ...`, `[auth] ...`. An error string with no origin turns
every future fix into a guess. Trace the request and response before assuming what caused an error.

## Local files and privacy

Keep environment values, credentials, and personal assistant notes out of Git. `.env.local`, local
agent instruction files, assistant settings directories, and plan or memory files (`XKG_PLAN.md`,
`*.local.md`, `plans/`, `notes/`, `memory/`) are ignored, and CI fails if any of them is tracked —
this repository is public. Commit only empty or non-secret environment templates. Next.js agent-file generation is disabled so starting development
does not create personal instruction files in the repository.

CLI briefing and vault hooks send the project name, branch, and recent commit messages to the
hosted service; they do not read local agent instruction files. Vault hooks also send the path of
the file being edited. Enable these hooks only for project context you intend to share.

## Pull requests

- Branch from `main`.
- One concern per PR. Security fixes especially: reviewable beats comprehensive.
- Say what breaks. If a change invalidates sessions, forces re-auth, or needs `init-db` re-run, put it
  in the PR body — that is the part a reviewer cannot infer from the diff.
- Add a test when you fix a bug. If the bug could return, something should fail when it does.
- Keep personal data out. This repository is public: tests, fixtures, docs and PR descriptions use
  made-up data, never real captures, file names, repository names, emails or URLs from anyone's
  account, even when a test reproduces a real incident. CI rejects committed secrets.

## Releasing the CLI

Each version is published to npm as `@xmu-labs/xkg` by `scripts/publish.sh`. Do not run `npm publish`
directly. Up to 1.8.0 every version was also published as `mnemos-capture`, the old name; it gets no
new versions.

1. Open a PR that runs `npm version <patch|minor|major> --no-git-tag-version`, so `package.json` and
   `package-lock.json` move together. Merge it.
2. GitHub → Releases → Draft a new release → create tag `vX.Y.Z`, with the bump commit as the target
   (Target → Recent commits), so a PR merged in between can't ride along → Publish. Mark it as a
   pre-release to publish under the `next` dist-tag instead of `latest`.

`.github/workflows/release.yml` refuses to publish unless the tag matches `package.json`, the tagged
commit is on `main`, and the version is not already on npm from another commit. It then runs the
checks, publishes with provenance through npm trusted publishing (no token), and confirms npm
recorded the tagged commit.

Trusted publishing is set up once on npmjs.com (the package → Settings → Trusted Publisher → GitHub
Actions: organization `xmu-labs`, repository `xkg`, workflow `release.yml`, Allowed actions with
`npm publish` ticked). If the workflow can't publish, a maintainer runs `scripts/publish.sh` (or
`scripts/publish.sh next`) by hand from a clean checkout of the tagged commit and re-runs the
workflow, which then skips the publish and only verifies.

## Security issues

Do not open a public issue for a vulnerability. Report it privately through
[GitHub Security Advisories](https://github.com/xmu-labs/xkg/security/advisories/new).

## Self-hosting

xkg is MIT licensed, so you may run your own instance. It is not a supported path and there is no
deployment guide: a self-hosted copy does not receive the security fixes made here, and this project
has shipped several that matter. The hosted instance at
[xkg.xmu.sh](https://xkg.xmu.sh) is the maintained way to use it.

## Tech stack

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19 |
| Language | TypeScript |
| Database | Vercel Postgres |
| Auth | GitHub OAuth · OAuth 2.1 + PKCE for MCP connectors |
| Storage | GitHub Contents API — your captures live in your repo |
| Agent interface | Model Context Protocol (Streamable HTTP + stdio proxy) |
| LLM | Anthropic SDK · Google and OpenAI-compatible providers via REST (BYOK, `src/lib/providers.ts`) |
| Styling | Tailwind CSS |
| Tests | Vitest (unit) · Playwright (e2e) |

