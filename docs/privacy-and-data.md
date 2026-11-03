# Privacy and data

**What's here:** where your captures live, what xkg stores, where your data goes, how your keys are protected, and how to cut access.
**Short version:** your captures live in your own GitHub repo. xkg's database holds only account plumbing, and xkg never sees your code.

This repo is public so you can check these claims in the code rather than trust them.

## Your captures stay in GitHub

Captures are Markdown files in **your** GitHub repo, private by default.

- **No lock-in:** clone it, move it, delete xkg, and keep the files.
- **No special format:** every capture is a readable `.md` file.
- **No training on your data:** captures go only to the AI provider you chose, with your key, to extract what you asked for. If you sync code maps, the extracted title, core idea, and takeaways also go to TypeSafe, which says where the capture applies and doesn't train on what it gets.
- **Any tool can read it:** anything that reads Git or speaks MCP.
- **Your key, your cost:** you pick the provider.
- **Never commit your xkg API key** to source control.

### Find your repo

Settings → Account shows your captures' repo, with a link to it on GitHub. Inside it:

| Path | What it holds |
| --- | --- |
| `inbox/YYYY-MM-DD-<slug>.md` | One Markdown file per capture. A second capture with the same name that day gets `-2`, `-3`, … |
| `applied/` | Captures applied in a commit |
| `archived/` | Captures you archived |
| `plans/` | Plans saved by older versions (`xkg agent --plan FILE` still runs them) |
| `INDEX.md` | A table of every capture: date, title, keywords, tags |
| `APPLIED.md` | Which capture went into which commit |
| `HANDOFFS.md` | Captures waiting for your coding agent: one row per capture and repo, with the suggested files, the fit, a status (`pending`, `snoozed:<date>`, `applied`, `declined`, `done`, `expired`, `dead`), the date of its last change, and whether it was queued automatically or by you. Closed rows leave after 90 days |

### Rename your repo

1. Rename it on GitHub as usual.
2. Open xkg once. It reads the new name from GitHub in the background, and Settings shows it from the next visit.

Until then, GitHub's redirect from the old name keeps captures working. **Don't create a new repo with the old name before you've opened xkg**, because GitHub drops the redirect when you do. You don't need to set up xkg again; doing so would replace your PIN and keys.

## What xkg stores

**xkg never stores your captures.** They're written straight to your GitHub repo (`src/lib/github.ts`). There's no captures table, so deleting the app leaves your knowledge untouched.

**The database holds only account plumbing** (`src/lib/db.ts`):

| Stored | What it is |
| --- | --- |
| `github_id`, `github_username` | Who you are |
| `github_token` | Encrypted (`src/lib/crypto.ts`) |
| `github_repo` | The *name* of your repo, not its contents |
| `pin_hash` | Salted scrypt (`src/lib/pin.ts`) |
| `api_key` | Hashed, not recoverable |
| Computer keys (`cli_keys`) | One per computer you signed in from with `xkg init`: a hash of its key (not recoverable), the computer's name, and when it was made and last used. A new MCP key in Settings deletes them all |
| Sign-ins in progress (`cli_logins`) | A browser sign-in, which expires after 10 minutes: a hash of the CLI's secret code, the code you check, the computer's name, and, once you approve, the new key encrypted until the CLI picks it up. The row is deleted when the CLI picks up the key or the sign-in is denied. An expired one can't be used and is deleted at the next sign-in (`src/lib/cli-login.ts`) |
| `llm_provider`, `llm_model`, `llm_effort`, `llm_api_key` | The key is encrypted. The provider, model, and effort are plain text |
| `display_name`, `avatar_data` | Optional in-app name and photo, never written back to GitHub |
| `token_version` | Bumped to revoke everything |
| Apply counts (`apply_events`) | One row per applied capture and commit: a keyed hash of the capture's file name, the first 7 characters of the commit, the AI client's name, whether a reason was given, and the time. Never the capture's name, content, or the reason |
| Code maps (`code_maps`) | Per repo you sync with the git hooks or add in Settings (20 at most): file paths, exported function and class names with their signatures, which mapped files import which, and each file's opening doc-comment line. For a repo added from GitHub, file paths only (`source = 'github'`). Never code, other comments, or package names (`cli/code-map.ts` builds it, `src/lib/code-map.ts` checks it, `src/lib/code-repos.ts` reads GitHub's file list) |
| Surface counts (`surface_events`) | One row each time xkg shows you a capture (capture card, briefing, recall, vault scan, session-start handoff offer): a keyed hash of the capture's file name, which of these showed it, and the time. For the capture card's match, also the tokens used, the model's own confidence (never shown), the scorer (`jev` or `evidence`), the fit, and whether it was shown to you. Never the capture's name or content |
| Model spend (`llm_spend`) | One row per model call xkg makes with your key: the provider, the model, the token counts your provider sent back, an estimated cost, and the time. Never the prompt or the answer. Settings → AI model shows this month's total |
| Monthly budget (`llm_budgets`) | Only if you set one in Settings → AI model: the amount in US dollars and when you last changed it. Clearing the field deletes the row |
| Handoff counts (`handoff_events`) | One row each time something happens to a handoff (queued, offered in a session at most once a day, expired, and your answer): a keyed hash of the capture's file name, the repo (`owner/name`), what happened, whether it was queued automatically or by you, the reason for a no, your agent's confidence, whether an apply came with a commit, and the time. Never the capture's name or content, and never the spec your agent writes. `HANDOFFS.md` and each capture's Handoff log in your repo are the record |
| Handoff learning (`handoff_scores`) | What xkg learned from your answers, per capture and file and per capture and repo: a weight, the number of nos, and the number of answers it came from, with keyed hashes of the capture's file name and tags, the repo (`owner/name`), the file path, and the date. Never the capture's name, content, or tags in plain text. It's a cache of the Handoff logs in your repo: `POST /api/admin/rebuild-handoff-index?user=<id>` rebuilds it from git for every capture in `HANDOFFS.md`. Deleting a capture deletes its rows |
| Setup steps (`setup_steps`) | One row per account and step, the first time it happens: your first saved capture, and the first tool call from an AI client or an xkg hook. Only the step name and the date. Read with your sign-up date, whether a knowledge repo and an AI key are set, and the first surface and apply counts, to see where new accounts stop during setup |
| Login attempts, OAuth clients and codes, refresh-token ids | Sign-in plumbing |

## Where your data goes

When you capture, the server talks to exactly four kinds of places:

1. **GitHub:** to write the capture into your repo, and to read (or refresh after a week) the file list of a code repo you add in Settings.
2. **Your AI provider**, with *your* key: the one you picked in Settings, to extract the capture.
3. **TypeSafe**, with xkg's key, only if you sync code maps: the extracted title, core idea, and takeaways, and the map entries (paths, exported names and signatures, opening comment lines, imported paths) of up to 15 files per repo. It also gets any file proven for one of the capture's tags, with a note naming that tag. Its model, Jev, says where the capture applies. If TypeSafe can't answer, the maps of your 5 most recently synced repos (names only) go to your AI provider instead.
4. **The page you captured:** if you paste a bare URL, so the model reads the real content. Only http and https, never an internal address.

There's no third-party analytics, telemetry, or tracking. The counts in the table above are the only usage xkg records.

Each capture, from the app or the `capture` tool, also writes one line to the server log (`capture.timing`). It holds which of the two it came from, the provider, model, and effort, whether the page was fetched, the token counts, and how long each step took. Never the capture's name, content, or URL.

## How your keys are stored

| Secret | How it's stored |
| --- | --- |
| GitHub token | Encrypted at rest (AES-256-GCM). Uses the `repo` scope, which is needed to read and write a **private** repo |
| Your AI provider key | Encrypted at rest (AES-256-GCM) |
| Your MCP API key | Hashed, so it can never be recovered, not even by xkg |
| Each computer's key from browser sign-in | Hashed, like the MCP key |
| Your PIN | Salted scrypt hash |

- **Your MCP key is shown once.** If you lose it, generate a new one.
- **PIN unlock is tied to the device.** It only works on a device that has already signed in with GitHub. A PIN alone can't reach your account.

## Cut access

- **Revoke everything:** generate a new MCP key in Settings. It invalidates the old key, every computer's key, every other signed-in session, and every connected MCP client. Sessions also expire after 30 days.
- **Remove xkg from a computer:** follow [these 5 steps](connect.md#remove-xkg-from-a-computer). Your account and captures stay.
- **Delete your account:** Settings → Delete account removes your account row and every record tied to it, and asks GitHub to revoke xkg's access (`src/lib/account.ts`). Your captures stay in your repo.

The hosted service's [Privacy Policy](https://xkg.xmu.sh/privacy) and [Terms of Service](https://xkg.xmu.sh/terms) say the same in legal form.
