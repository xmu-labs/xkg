# How xkg works

**What's here:** the full loop, from capture to a commit that applies it, what the app shows you, and what it costs.
**Short version:** you capture outside knowledge, xkg finds where it fits in your code, and your coding agent applies it after asking you.

<p align="center">
  <img src="https://raw.githubusercontent.com/xmu-labs/xkg/main/public/flow-workflow.svg" width="720" alt="Docs and notes → Capture → GitHub Markdown → Brief → Plan → Execute → Mark applied" />
</p>

## The loop

### 1. Capture

Paste anything text-based: papers, docs, posts, GitHub repos, notes, decisions, ideas, or transcripts. xkg tells a URL, a short note, and longer text apart on its own. There's nothing to tag.

From the app, paste and hit **Capture**. From a connected agent, just ask:

```text
capture "The Mom Test: don't ask if your idea is good. Ask about the person's real behavior, current workflow, and past spending."
```

xkg pulls out the **core idea**, **key takeaways**, **where to apply it**, and the **capture type**. Each claim is backed by an exact quote from the source, and xkg checks that the quote is really there.

Then it commits a Markdown file to your GitHub repo, with the source text attached. See the [example capture](#example-capture).

#### Where it applies

If you sync a [code map](#code-map), each capture also gets a **Where it applies** section: the repo and up to 3 files where it may change something. These are suggestions from file and function names, not yet checked against your code.

How xkg picks the files:

1. It ranks your mapped files by the names they share with the capture.
2. [TypeSafe](https://typesafe.ai)'s decision model, Jev, rates the top 15 files of each repo. It asks two questions: would applying the capture change this file, and does anything in the repo fit at all? A word the capture shares with the repo doesn't count when it means something else there (a capture about agents handing off context between sessions isn't about a repo feature that is also called handoff).
3. A file rated 0.50 or more is a **Strong fit**. A file rated 0.40 or more is a **Possible fit** (0.30 or more when the map has signatures and comment lines, because Jev answers more cautiously then).
4. Each file shown lists the exported names it shares with the capture.

Your own model is only used to extract the capture. If TypeSafe can't answer, your model picks the files instead:

- Every path is checked against your map.
- A reason that names a function the file doesn't export is dropped.
- The fit comes from how well the names match, never from the model's own rating.

When nothing fits, xkg says why in one line. With no map, the capture is saved without this section.

#### Handoffs: from capture to your coding agent

- **Strong fit:** xkg queues it for your coding agent by adding a row to `HANDOFFS.md` in your knowledge repo, with the capture, the repo, and the suggested files.
- **Any other fit:** it waits for you. Tap **Hand off to your coding agent** on the capture card, right after capturing or later on the capture's page in **Your knowledge**. You can pick an "also fits" repo first; that row has no files, and your agent finds them.

Once a capture is queued for a repo, the card shows where it stands there instead of the button: **Sent** ("Sent to your coding agent on Nov 2. It asks you at your next session in owner/name."), **Snoozed** (you said not now), **No answer** (offered 3 days with no answer; you can hand it off again), **Not a fit**, **Applied**, **Done**, or **Not offered** (turned down twice). Pick another repo in the switcher to hand it off there.

Rows hold names only, never code. You can edit or delete the file at any time.

In your next coding session in that repo, your agent offers what's waiting: "xkg: 2 captures fit this repo (owner/name). Want to see them and apply one?" This works with any `briefing` call that names the repo, which the session-start hooks do. Hooks only run when a session starts, so when you open or add another repo mid-session, your agent calls `briefing` again with that repo (the instructions xkg sends, and the lines `init` writes, tell it to) and offers what waits there. In a chat app, your AI is told how many wait and in which repo instead. A connector with no hook can start the same briefing from the xkg **briefing** prompt, where the app shows MCP prompts.

If you say yes and pick one:

1. Your agent reads the capture and the files.
2. It writes a spec to `.xkg/handoffs/<capture>.md` in that repo: the claim, evidence quoted from the capture, why here, the files it opened and the change, checks, and its confidence (High, Medium, or Low).
3. It asks "Apply this now?" If you say yes, it makes the change and adds the `xkg-capture:` line to the commit.

The spec stays on your machine. `.xkg/` is kept out of git (`setup-git-hook` adds it to `.git/info/exclude`), and it never goes to xkg.

If a suggested file is no longer in your current map, it's marked "moved or deleted since the capture", so your agent looks for where it applies now. A capture offered on 3 days with no answer stops being offered, and its row says `expired`.

#### Your answers

Your agent records your answer with `apply_capture`. The capture page doesn't ask you to judge the fit: that's xkg's job. If an offer is wrong, say no to your agent, and xkg learns from that answer.

| You say | Recorded as | What happens |
| --- | --- | --- |
| Not now | `later` | Offered again in 7 days |
| No | `declined` + a reason: `wrong-files` (fits, but not in those files), `doesnt-fit` (not in this repo), or `other` | xkg [learns from it](#how-xkg-learns-from-your-answers) |
| Already done | `done` | Closed, not counted as an apply |
| Yes, and you commit it | `applied` | Marked applied (see [step 5](#5-mark-it-applied)) |

- Only a commit counts as an apply. `later`, `declined`, and `done` don't move the capture or add an `APPLIED.md` row.
- A `git revert` of an applying commit is recorded as `reverted`.
- Every answer adds a line to the capture's `## Handoff log`: the date, the repo, the answer and its reason. For an apply, it also adds the commit and the files it changed (only files in your code map).
- When your agent and the git hook both report the same commit, it's logged once. The later report fills in anything the first left out.
- No answer carries the spec, code, or a diff.
- Closed rows (`applied`, `declined`, `done`, `expired`) leave `HANDOFFS.md` 90 days after their last change. The Handoff log keeps the history.

#### How xkg learns from your answers

There's no model involved, just counting:

- An apply counts +1 for each file it changed and for the repo.
- A `wrong-files` no counts -1 for each suggested file. A `doesnt-fit` no counts -1 for the repo.
- A revert takes back the apply's +1 and counts -1.
- `later`, `done`, and `expired` count nothing. Every count halves every 30 days.

What that changes:

- Two nos or reverts on a file make it a dead end for that capture. Tapping **Hand off** again leaves it out.
- Two on a repo mark the capture's row `dead`, so it's never offered there again.
- A file changed by applies of two captures that share a tag is **proven** for that tag. For a new capture with that tag, Jev also rates that file, with a note that it was applied before. Jev still decides the fit.

### 2. Brief

At the start of a work session, your agent asks for a briefing. xkg uses your project name, branch, and recent commit messages to pick up to 5 captures that may fit, with why each may fit and its key points.

xkg never sees your code, at most file and function names from a code map. So a briefing gives candidates: your agent reads the code, keeps only real matches, names the file and the change, and asks you before changing anything. The CLI hooks don't read or upload your local agent instruction files.

### 3. Plan

The handoff spec from step 1 is the plan. Your agent writes it after reading the files.

Plans that older versions saved to `plans/` in your knowledge repo still run with `xkg agent --plan FILE`.

### 4. Execute

Your agent applies the plan in your current session. Or run it in a separate git worktree:

```bash
npx -y @xmu-labs/xkg@latest config set agent "claude -p"
npx -y @xmu-labs/xkg@latest agent --spec .xkg/handoffs/<capture>.md
```

`xkg agent` creates a worktree, loads the plan, starts the assistant you set, and prints a checklist to verify when it's done. It reads the spec from your disk and needs no key. For Codex, use `config set agent "codex exec"`.

### 5. Mark it applied

After a commit that applies a capture, your agent calls `apply_capture` with the commit sha and one line on why. xkg moves the capture to `applied/`, adds it to the capture's log and to `APPLIED.md`, and counts it once per capture and commit.

Any agent, or you, can also add this line to the commit message:

```text
xkg-capture: 2026-10-28-alert-ownership.md
```

With the git hook in that repo, xkg records it after each commit, with the repo and the changed files. If you later `git revert` that commit, the `APPLIED.md` row is marked "reverted" with the date. It still counts as an apply that week.

Your agent offers to set up the hook the first time it connects. Or run it in the repo:

```bash
npx -y @xmu-labs/xkg@latest setup-git-hook --key YOUR_API_KEY
```

Ask "apply stats" to see how many captures you applied each week.

## Code map

The git hook also keeps a **code map** of the repo, so xkg can tell where a capture applies.

- **What's in it:** file paths, exported function and class names with their signatures (no bodies, no default values), which files import which, and the first sentence of the doc comment each file opens with.
- **What's never in it:** code, other comments, or package names.
- **When it's sent:** after a commit, a pull, or a branch switch when a name changed, and at most once a day otherwise. Run `xkg map` to send it now.

It works through git alone, so it's the same with every coding agent, or none. In a cloud container, which starts with no hooks, add the `setup-git-hook` line to the environment's setup script.

**Settings → Code repos** lists every repo xkg matches captures to, with where its map came from and when.

- To add a repo you haven't opened with the hook, type `owner/name` under *Add a repo from GitHub*. xkg reads its file names with your GitHub sign-in (paths only, never file contents) and refreshes them when they're a week old.
- A map from your machine replaces it the next time the hook runs there.
- *Remove* deletes a repo's map. Captures stop matching it until it's synced or added again.

## The app

### Capturing

In the app, paste a URL, a note, a doc excerpt, a transcript, or an idea, then hit **Capture**.

- While it works, the app shows each step (reading the page, extracting, saving) and the seconds so far.
- The result shows as soon as the file is saved, in the app and in the `capture` tool.
- Links to related captures and the **Where it applies** section are added a few seconds later. Links come from shared tags and words, with no extra AI call, and each says what the two captures share (for example `shared: reliability, retries`).
- **Slow capture?** When the model took 20 seconds or more, the result offers a faster model your provider serves, with its measured time: "This took 25 s. gpt-4.1 usually takes about 4 s." **Use** switches to it (with **Undo**). **Keep mine** stops the offer for that model and effort. It only suggests a model that keeps the checked quotes about as well. See [how the fast model is measured](#how-the-fast-model-is-measured).
- **Captured the same thing twice?** Each capture is saved as `inbox/<date>-<short-name>.md`. If that name is already taken that day, the new capture is saved as `…-2.md` (then `-3`, and so on). Nothing is overwritten.
- **When a capture fails**, the app says why in one sentence and what to do next. For example: "Your OpenAI key has no credits left. Add credits with OpenAI, or pick another model in Settings → AI model." When a key has run out of credits, the message links straight to that provider's billing page ("Open OpenAI billing"), and a capture from a coding agent puts the billing URL in the sentence. This covers a key with no credits, a key the provider refused, a rate limit, a model the provider doesn't offer, a provider outage, and GitHub refusing the save. It works the same for every provider.
- **When there's nothing to save**, nothing is saved. If the model finds no clear idea, the app doesn't add an empty capture. It says why and keeps what you typed, so you can paste the text instead. For a link, the reason is the one the page gave: the site blocks automated readers (a bot check like Cloudflare's "Just a moment…"), it needs you to sign in, the page wasn't found, the link isn't a web page (a PDF, say), the page had almost no text (it may need JavaScript), or it couldn't be reached. Example: "This site blocks automated readers, so xkg couldn't read the page. Nothing was saved. Paste the page's text instead." The `capture` tool doesn't open links, so an agent that sends only a link gets: "…Read the page and call capture again with its text." Either way, the try doesn't count against your hourly captures.

On a phone, open the app → **Share → Add to Home Screen**. It runs like a native app.

### The Apply it card

After a capture, the app says **Added to your knowledge** and shows an **Apply it** card under the core idea:

- **The fit:** **Strong fit** (green) or **Possible fit** (amber), with the repo, the files where it may change something, and the hand-off button. With no fit, the card shows the capture's general advice instead.
- **Why** (up to 12 words): what in the capture touches the file.
- **Impact** (up to 32 words): what likely changes in your code once it's applied, then what that gets you, written as "change, so result".

Your own model writes Why and Impact from the capture and the file's path, one-line summary, and exported names, never its code. A Strong fit gets them right away; a Possible fit has a **Why and how** button.

They're saved in the capture's "Where it applies" section as `` - `path`: why · Impact: impact ``, so each capture is explained once. The call is capped at 400 output tokens and runs at low effort.

Captures from before this change hold `· After:` lines. The first time one is opened, its lines are rewritten once as Impact.

### Menu and Your knowledge

The **☰ menu** (top right on every page) holds your account, **Capture**, **Your knowledge**, and **Settings**. It also shows the GitHub repo your captures are stored in.

**Your knowledge** lists what you saved, by folder: inbox, applied, and archived. From there you can:

- **Open** a capture to read it in full: core idea, takeaways, source, where it applies, when it was applied, and links to related captures.
- **Archive** a capture you've read but won't act on now, or **Delete** it for good (it asks first).
- **Source check:** when the page opens, xkg checks each inbox capture's source URL. If the page is gone (404 or 410), the capture says so, and reminds you that what you learned is saved in your repo. A capture the AI marked low confidence gets a short note too. Nothing is archived for you.
- **Make rules** from every capture with a tag. They go in `RULES.md`, and your agent gets them with the session-start briefing. This runs on your own model and key.
- See how many captures were applied each week, and how many came with a commit (from `APPLIED.md`).

## Example capture

You paste:

```text
Note to self after the incident review: our alerts fired, but nobody owned them. Alerts without a named owner get ignored. Every alert needs one person on the hook, not a channel.
```

xkg saves:

```markdown
---
date: 2026-10-28
source: Alert ownership importance
type: notes
source_type: note
tags: incident-management, alerting, responsibility
status: inbox
source_sha256: 21275782a8bf…
---

# Alert ownership importance

## Core idea
Alerts in incident reviews must have a designated owner to ensure
they are acted upon, as unowned alerts tend to be ignored.

## Key takeaways
- Every alert needs one person responsible for it to prevent neglect.
- Alerts without a named owner are typically ignored.

## Evidence
**Core idea** · `c-ac3270c3bbc8`
> "Alerts without a named owner get ignored." (s1)

**Takeaway 1** · `c-59d033daf0e2`
> "Every alert needs one person on the hook, not a channel." (s1)

<details>
<summary>Source text (sha256: 21275782a8bf…)</summary>

[s1] Note to self after the incident review: our alerts fired, …
</details>
```

This is shortened from a real capture. Every claim points to a quote that appears word for word in the source text, so you can check it. It's plain Markdown in a repo you own: readable, editable, versioned, and portable.

## Cost

You bring your own AI key and pay your provider directly. xkg never charges you for AI.

Each provider starts on a low-cost model, which you can change in Settings → AI model. For example, Anthropic starts on Claude Haiku 4.5, OpenAI on GPT-4o mini, and Google on Gemini 2.0 Flash.

A capture uses about 2,000–3,700 input tokens and 500–1,400 output tokens, depending on the source's length. That was measured in October 2026 with the current extraction prompt, on a reasoning model. Each claim cites one short quote, and the answer is capped at 2,000 tokens.

- Linking related captures uses no model.
- **Where it applies** runs only when you sync a code map. It goes to TypeSafe's Jev on xkg's key, or to your model when Jev can't answer.
- Briefing, planning, and making rules only run when you ask.

At list prices:

| Captures per month | Claude Haiku 4.5 | GPT-4o mini |
| --- | --- | --- |
| 50 | ~$0.40 | ~$0.05 |
| 100 | ~$0.80 | ~$0.10 |
| 200 | ~$1.60 | ~$0.20 |

Larger models cost more.

### What you've spent this month

Settings → AI model shows what xkg spent with your key this month, for example "This month: 23 calls with your key, about $0.41." Every model call xkg makes with your key counts: captures (web and coding agents), Why and Impact, rules, and the "Where it applies" fallback to your model. xkg reads the token counts your provider sends back and prices them at list prices (`src/lib/llm-prices.ts`).

It's an estimate, not a bill:

- **xkg only sees its own calls.** If you use the same key in other apps, that spend doesn't show here. Your provider's billing page is the real number.
- **Prices change.** Cached input is counted at the full input price, so the figure leans high.
- **A model with no price on file** (a fine-tuned or new model) shows its tokens, not a dollar amount.

### Monthly budget

You can set a monthly budget in US dollars under Settings → AI model (Monthly budget, then Save budget). Clear the field and save to remove it. When this month's estimate reaches 80% of the budget, the home page shows a banner with a link to your provider's billing page and a Change budget button that opens Settings; at 100% it shows again, even if you dismissed the first one. "Got it" hides a banner for the rest of the month on that browser.

The budget is a warning, not a limit. Captures keep working past it, because the estimate can be off and only your provider can stop charges to your key. To set a hard cap, use your provider's own spend limit. The budget follows the same estimate as above, so calls with this key from other apps don't count toward it.

### How the fast model is measured

`scripts/measure-model-speed.ts` runs the same sources (public articles and short notes) through a few fast models and one reasoning model per provider. For each model, it records the mean extraction time and the share of takeaways that keep a checked quote.

The fastest model whose share stays within 10 points of the reasoning model's is saved to `src/lib/model-speed.json` with the date. The capture card and Settings → AI model quote that time.

A result older than 90 days, or for a model the app no longer lists, is never quoted. Providers that haven't been measured get no offer. See [CONTRIBUTING.md](../CONTRIBUTING.md) to run it.
