# marshal-factory

A software factory that turns tasks into pull requests while you watch.

You file a job from the panel, over HTTP, or from Slack, and, when Linear is configured, by labeling an issue. A runner on your Mac picks it up within seconds and starts a [T3 Code](https://github.com/pingdotgg/t3code) thread for it on its own branch, `factory/<key>`, either on the Mac itself or in its own [Modal](https://modal.com) sandbox in the cloud. The thread runs a harness (Claude Code, Codex, or another agent T3 offers, such as Cursor) with PStack, and works the job on its own: triage, investigation, implementation, verification, and a pull request. Every stage, subagent, model and dollar spent streams live to a web panel, and Slack tells you when something needs you. When the agent needs a decision, it asks on the job and continues once you reply.

When the PR is ready, the agent reports whether it is confident it built what the issue asked for. In repos you switch to **Merge when confident**, the factory merges every PR the agent is confident about and that clears the hard limits (green checks, no conflicts, no open Bugbot findings, checks verified at the PR head), and reverts a merge that turns main red. Everything else is handed to you to review and merge from the panel, Slack or GitHub ([Merge decisions](docs/operations.md#merge-decisions)).

![The whole factory: sources, Neon, your Mac, Modal, Vercel and GitHub, with the numbered path one ticket takes](docs/images/factory-diagram.jpg)

The pieces:

- **Panel** (`app/`, `components/`): a Next.js app on Vercel. Its **Jobs** page shows every job as a board or a list (the header's Board/List switch; the panel remembers your pick), with each run's timeline and cost in a side panel you can expand to full view. **Inbox** lists what needs you: questions, PRs to review, failures. The panel files jobs and approves merges. Only the owner can sign in.
- **Ingest Function** (`functions/ingest/`): a Neon Function that receives GitHub webhooks, Linear webhooks when Linear is configured, and the reporter's events, and writes them to Postgres.
- **Runner** (`runner/`): a Bun daemon on your Mac, run by launchd. It is the only part that touches T3, git and the GitHub API, starts and hibernates the Modal sandboxes, makes every merge, and posts the Slack notifications.
- **Slack app** (`app/api/slack/`, optional): notifications, buttons to answer, merge or request changes, and `/factory` to file jobs. The routes run on Vercel and act through the same inbox actions as the panel.
- **Reporter** (`hooks/`, `mcp/`): Claude Code hooks and a small MCP server, installed into each target repo. They send the run's progress to the ingest Function.
- **Playbook** (`playbooks/factory.md`): the instructions every factory thread follows. It extends PStack's bug-fix and feature playbooks.

## What you need

Accounts:

- **GitHub**, for the target repo and a GitHub App the setup creates for you.
- **Linear** (optional). Without it, jobs live in the factory's own queue in Postgres. With it, labeling an issue still works, and New job can file there too.
- **Neon**, for Postgres, Auth, Realtime and the ingest Function.
- **Vercel**, for the panel.
- Optional: **Modal**, to run jobs in cloud sandboxes ([Running jobs in Modal sandboxes](#running-jobs-in-modal-sandboxes)), and **Slack**, for notifications and acting from Slack ([Connecting Slack](#connecting-slack)).

On the Mac that runs the factory:

- macOS. The runner installs as a launchd agent and identifies the Mac by its hardware UUID.
- [Bun](https://bun.sh), git, and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). Threads push branches and open PRs with your own git and `gh` credentials.
- Claude Code with the PStack plugin installed.
- T3 Code, running, with its `t3` command line tool. The installer looks for it at `~/.t3/bin/t3`, then on your `PATH`, or you can set `T3CODE_CLI_PATH`.
- The `neon` CLI, signed in, and the `vercel` CLI.
- `jq` and `openssl`, used by a few commands below.

A Linux VPS can run the runner in place of the Mac. [Runner on a Linux VPS](#runner-on-a-linux-vps) is that setup. The install below is the Mac.

## Install

These steps set up one factory: one Neon project, one panel, and one Mac running the runner. Do them in order. Several steps depend on values an earlier step creates.

### 1. Clone the factory

```sh
git clone https://github.com/<you>/marshal-factory.git ~/code/marshal-factory
cd ~/code/marshal-factory
bun install
```

Fork the repo first if you want Vercel to deploy your copy. This checkout is the **live checkout**. The runner, and the hooks installed into your target repos, run code straight from this path. Keep it on `main` and don't move it. Do development work in a separate clone or worktree.

### 2. Values tied to this fork

This checkout already names its own GitHub App and production database:

- `scripts/setup-github-app.ts`: the manifest `name` is `marshal-factory-dougclift` and `url` is `https://github.com/dougclift/marshal-factory`.
- `lib/migrate-guard.ts`: `PRODUCTION_ENDPOINTS` includes `ep-young-lab-bdupe8pr`, this fork's production compute endpoint, so a preview build cannot migrate production. Add an id there if the production branch gains another endpoint.

### 3. Linear (optional)

Skip this step to run without Linear. Jobs then live in the factory's queue. Come back to it later if you want Linear as a second source.

In the Linear team you want the factory to work in:

- Note the team key, the prefix of its issue ids. The defaults assume `FAC`.
- Make sure the team has the workflow states **Todo**, **In Progress**, **In Review** and **Done**. The factory moves issues between them by name.
- Create a label named `factory`. Only issues with this label in an unstarted state (such as Todo) are picked up.
- Create a personal API key under Settings → Security & access.

If your team key or label differs, set them in every place listed under [Settings](#settings).

### 4. Create the Neon backend

Create a project, link this checkout to it, and turn on Realtime for `main`:

```sh
neon projects create --name marshal-factory
neon init --no-agent-setup      # links this directory to the project; writes .neon
neon realtime enable --branch main --allowed-origin '*'
```

Create `.env.local` with the secrets you choose yourself:

```sh
cat > .env.local <<EOF
FACTORY_INGEST_SECRET=$(openssl rand -hex 32)
NEON_AUTH_COOKIE_SECRET=$(openssl rand -base64 32)
FACTORY_OWNER_EMAILS=you@example.com
# neon env pull and neon deploy evaluate neon.ts. Until the GitHub App exists, this
# placeholder keeps them from reading github-app.json. Step 6 replaces it.
GITHUB_APP_WEBHOOK_SECRET=pending
EOF
chmod 600 .env.local
```

Add these only if you prepared Linear in step 3. Leave them out otherwise:

```sh
LINEAR_API_KEY=<your Linear API key>
LINEAR_WEBHOOK_SECRET=$(openssl rand -hex 32)
FACTORY_TEAM_KEY=FAC
FACTORY_LABEL=factory
```

Deploy `neon.ts` to `main`, which turns on Neon Auth, sets Realtime's allowed origins from `preview.realtime.allowedOrigins` (replacing the `*` above), and deploys the ingest Function. The GitHub App doesn't exist yet; the placeholder above is what `neon.ts` reads instead of `github-app.json`.

```sh
neon deploy --branch main --env .env.local --no-env-pull
```

Pull the values Neon generated, then create the tables. `neon env pull` evaluates `neon.ts`, so the placeholder has to be set for that process too (it is already in `.env.local`; the prefix covers a CLI that evaluates the file before reading it):

```sh
GITHUB_APP_WEBHOOK_SECRET=pending neon env pull --branch main
echo "NEXT_PUBLIC_NEON_REALTIME_URL=$(grep '^NEON_REALTIME_URL=' .env.local | cut -d= -f2-)" >> .env.local
bun run db:migrate
```

`.env.local` now also holds `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET`, `NEON_BRANCH_ID` and `NEON_FUNCTION_HOST_SUFFIX`. The ingest Function's origin is `https://<NEON_BRANCH_ID>-ingest<NEON_FUNCTION_HOST_SUFFIX>` (the suffix looks like `.compute.c-2.us-east-2.aws.neon.tech`). A pull from an older CLI may instead have written `NEON_FUNCTION_INGEST_BASE_URL`; scripts use that value when it is set.

`PRODUCTION_ENDPOINTS` already lists `ep-young-lab-bdupe8pr`. You do not need to edit it for this project.

### 5. Write the runner's config

The runner and the reporter read `~/.config/marshal-factory/config.json`:

```sh
mkdir -p ~/.config/marshal-factory
set -a; source .env.local; set +a
if [ -n "${NEON_FUNCTION_INGEST_BASE_URL:-}" ]; then
  INGEST_BASE="${NEON_FUNCTION_INGEST_BASE_URL%/}"
else
  INGEST_BASE="https://${NEON_BRANCH_ID}-ingest${NEON_FUNCTION_HOST_SUFFIX}"
fi
jq -n --arg url "$INGEST_BASE/ingest" --arg secret "$FACTORY_INGEST_SECRET" \
  '{ingestUrl: $url, secret: $secret, factory: {teamKey: "FAC", label: "factory"}}' \
  > ~/.config/marshal-factory/config.json
chmod 600 ~/.config/marshal-factory/config.json
```

`linearApiKey` is optional. Add it only when this factory uses Linear: `jq --arg key "$LINEAR_API_KEY" '. + {linearApiKey: $key}'` applied to the file above. `secret` must equal `FACTORY_INGEST_SECRET`, or ingest rejects the reporter's events. [Settings](#settings) lists the optional limits you can add under `factory`.

### 6. Create the GitHub App

The runner reads and merges PRs as a GitHub App, not as your `gh` login:

```sh
bun scripts/setup-github-app.ts
```

A browser page opens and sends the app manifest to GitHub. Click **Create GitHub App**, pick the repos the factory may work in, and click **Install**. The script saves the app's id, private key and webhook secret to `~/.config/marshal-factory/github-app.json` (mode 600). You can add repos to the installation later in GitHub's app settings.

Now give the ingest Function the real webhook secret:

```sh
neon functions deploy ingest --branch main --src functions/ingest/index.ts \
  --env GITHUB_APP_WEBHOOK_SECRET="$(jq -r .webhook_secret ~/.config/marshal-factory/github-app.json)"
```

### 7. Create the Linear webhook (optional)

Skip this when Linear is not configured. `bun scripts/install-webhooks.ts` exits without changing anything if `linearApiKey` or `LINEAR_WEBHOOK_SECRET` is missing.

```sh
bun scripts/install-webhooks.ts
```

This registers a webhook on your team (Issue and Comment events) that points at the ingest Function, and records its id in the config. Running it again reuses the existing webhook.

### 8. Deploy the panel

Import the repo into Vercel as a Next.js project. `vercel.json` already sets the build command (migration guard, then migrations, then build) and the region. Then:

- Add these environment variables for Production. Mark the secrets as Sensitive.
  - `DATABASE_URL`, `DATABASE_URL_UNPOOLED`
  - `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`
  - `NEON_REALTIME_URL`, `NEXT_PUBLIC_NEON_REALTIME_URL`, `NEON_REALTIME_SECRET`
  - `FACTORY_OWNER_EMAILS`
  - `FACTORY_INGEST_SECRET`, the same value as in `.env.local`, so `POST /api/jobs/file` can file a queue job
  - `LINEAR_API_KEY` (optional), so New job can file in Linear as well as the queue
  - `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, from `~/.config/marshal-factory/github-app.json`, so **Add repository** can list the repos the App reaches
  - `FACTORY_TEAM_KEY` and `FACTORY_LABEL`, if they differ from `FAC` and `factory`
  - Optional: `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, so you can paste a repo's secrets in the panel instead of running a command on the Mac
  - Optional: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_OWNER_USER_ID` ([Connecting Slack](#connecting-slack))
- Set the Ignored Build Step to `[ -z "$DATABASE_URL" ]`, so previews without a database are skipped. To get previews with their own Neon branch, connect Neon's Vercel integration. Each preview then migrates its own branch, and the migration guard stops any preview that points at production.

Deploy, then add each origin the panel is served from to Neon Auth's trusted domains. This fork's panel is `https://marshal-factory-dougclift.vercel.app` and `https://build.gameday.support`. A new branch has none, and without this sign-up fails with "Create account failed: Invalid origin.":

```sh
neon neon-auth domain add https://marshal-factory-dougclift.vercel.app --branch main
neon neon-auth domain add https://build.gameday.support --branch main
```

A custom domain must also be added to `preview.realtime.allowedOrigins` in `neon.ts`, then `neon deploy` run, or live updates from that origin are refused.

Then create your owner account. Sign-up is off by default. The [owner account steps](docs/operations.md#panel-access-and-deploys) turn it on briefly, so you can register with an address from `FACTORY_OWNER_EMAILS` and confirm it with the emailed code.

### 9. Start the runner

```sh
bun scripts/install-runner.ts
tail -f ~/Library/Logs/marshal-factory/runner.log
```

This installs the LaunchAgent `com.marshal-factory.runner`. It starts at login and restarts if it exits. Within a minute the log shows `realtime` `live` and a `heartbeat`, and your Mac appears under **Machines** in the panel. The runner still needs a repo to work in, which the next section adds.

## Add your repo

A target repo is any git repo whose `origin` is on GitHub and whose default branch is `main`. The GitHub App must be installed on it.

```sh
bun scripts/install-target.ts ~/code/my-app
```

This writes three things into the repo, all pointing at your live checkout:

- `.claude/settings.json`: the reporter hooks.
- `.mcp.json`: the `factory-report` MCP server.
- `.agents/playbooks/factory.md`: a copy of the factory playbook. Threads follow the factory's own `playbooks/factory.md`, which every launch message names; the copy may only add notes about the repo.

It merges with any settings the repo already has, adds `.claude/**` to the ESLint ignores when it can, and adds the repo to `factory.repos` in your config. Running it again changes nothing.

Commit those files and push them to `main`. Every thread starts from a fresh worktree of `origin/main`, so a thread can only see the hooks once they're on `main`.

Then restart the runner so it loads the new repo: `bun scripts/install-runner.ts --uninstall && bun scripts/install-runner.ts`. At startup the runner adds each checkout in `factory.repos` to the panel's **Repositories** page, and the first one becomes the default repo when there is none yet.

## Repositories

The factory can work in several repos. **Repositories** in the panel lists each one with its open jobs, its last job, where its jobs can run (Modal, a runner's local checkout, or neither yet) and how far the factory may merge there. Open a repo to change its display name, make it the default, disable it, give it a default harness and place, or set merging and **Require Bugbot review**.

An issue picks its repo with a child of the **Repository** label group in Linear, named by the repo's display name (`factory-demo` for `ski043/factory-demo` unless you rename it). An issue without one goes to the default repo. A label that names an unknown or disabled repo also goes to the default, and the issue gets one comment saying so. **New job** has a Repository select and always files the issue with its Repository label.

Per repo, a default harness and place apply when the ticket has no Harness or Runs on label: the ticket's label beats the repo default, which beats Settings. A local run needs the runner's checkout of the repo; without one the job runs in a Modal sandbox when Modal is ready, and otherwise stays queued.

To add a repo, click **Add repository** on the Repositories page and pick one of the repos the GitHub App can reach. **Grant access to more repositories** opens the App's installation settings when the one you want is missing. The factory then onboards it without you:

1. If the repo's `main` has a `.factory/setup.json`, the factory uses it. Otherwise an agent reads the repo in a Modal sandbox, writes that setup recipe, runs the setup and every check until they pass, and opens a pull request titled **Add the factory setup recipe**. Merge it when it looks right.
2. If the recipe names secrets the checks need, the repo shows **Needs input** with each name and what it is for. Paste the values in the repo's detail pane, or, when the panel has no Modal token, run the command it shows on the runner Mac (`bun scripts/repo-secret.ts owner/name NAME`), which asks for the value without echoing it. Values go straight to a Modal secret for that repo and are never stored by the factory.
3. The factory builds a warm sandbox image with the repo cloned and set up, and the repo turns **Ready**. Its Modal jobs start from that image, and a push to `main` that changes the recipe or a lockfile rebuilds it in the background.

The new repo also gets its child in the **Repository** label group. A repo you also want to run locally still needs `bun scripts/install-target.ts` on the runner Mac ([Add your repo](#add-your-repo)). [docs/operations.md](docs/operations.md#onboarding-a-repository) has the details.

The Jobs page and the Inbox have a repository filter in the header. It is kept in `?repo=owner/name` and remembered for the next visit. Cards and rows show their repo once more than one repo has jobs.

## Use it

**Start a job.** Either:

- In the panel, click **New job**, then write a title, a description, and optionally paste or drop images. **File in** is Queue, or Linear when `LINEAR_API_KEY` is set. With no Linear key, Queue is the only choice.
- Over HTTP, `POST /api/jobs/file` with the ingest secret. See [File a job over HTTP](#file-a-job-over-http).
- In Slack, type `/factory <what to build>`, or pick **Send to factory** from a message's ⋯ menu. Both open the same form, including the source choice when both exist ([Connecting Slack](#connecting-slack)).
- In Linear, when it is configured, add the `factory` label to an issue in Todo.

To run one issue on another harness or place than Settings, add a child of the **Harness** or **Runs on** label group, and to send it to another repo than the default, a child of **Repository**; `bun scripts/sync-linear-labels.ts` creates the groups ([Per-ticket overrides](docs/operations.md#per-ticket-overrides), [Repositories](#repositories)).

Within seconds the issue moves to In Progress, a comment says the factory took it, and a card appears on the board. Write the issue the way you would for a colleague who can't ask questions: what's wrong or what you want, and how you'll know it's done. Images on the issue are downloaded and given to the thread.

**Watch it.** Cards move through Queued, Triage, Investigating, Implementing, Verifying and PR. Open a card to see the stage history, the agents and subagents, the models, and the spend; the expand button next to its close button (or `?full=1` in the link) opens it in full view, and Esc goes back. **Other activity** lists Claude Code sessions that report no factory stage, such as work you start by hand in a target repo. **Machines** shows each runner's Mac, its load, and its T3 projects.

![The panel's board: runs grouped by stage, each card showing its ticket, model, spend, and machine](docs/images/panel-board.png)

**What needs you.** The panel's **Inbox** collects everything waiting on you: questions, PRs handed over for review, failures, failed reverts and stops that couldn't be confirmed, each with its actions. With Slack connected, each one also arrives as a message with the same buttons, which is edited once the item is resolved.

**Answer questions.** When the job is ambiguous or something blocks the run, the card moves to Waiting, and the question is posted on the job (a Linear comment, or a comment on the queue row), usually with options to pick from. Reply on the job, in the Inbox, or with **Answer** in Slack. The thread continues with your answer.

**Review and merge.** At the PR stage, the issue moves to In Review with a link to the pull request, and the agent reports whether it is confident in what it built. In a repo set to **Merge when confident**, a confident PR that clears the hard limits is merged by the factory. Otherwise it lands in the Inbox: review it as you would any PR, then merge from the panel (**Merge**, or **Approve and merge** in the Inbox), with **Approve and merge** in Slack, or on GitHub, or send it back with **Request changes**. Every merge the factory makes, including your approvals, is done by the runner. Either way, the issue moves to Done and the worktree or sandbox is cleaned up. If main moves on and the PR conflicts, the factory tells the thread to merge main and fix it.

**Stop a job.** In Linear, remove the `factory` label or cancel the issue. The runner stops the thread.

**When it fails.** A job fails when the agent gives up, or when it stays stuck after one nudge. The reason is posted on the issue, the issue goes back to Todo, and the label changes to `factory-failed`. To retry, press **Retry** on the job's item in the panel's Needs you inbox or in its Slack message, with an optional note for the next attempt, or add `factory` to the issue again. The retry runs on a new branch (`factory/FAC-7-a2`). A failed job's worktree is kept for three days, so you can look at what it did. Spend is measured per attempt and shown on the card; no amount stops a run.

## File a job over HTTP

`POST /api/jobs/file` files a job in the queue, the same path as New job with Queue selected. It does not use a panel session. Send `Authorization: Bearer $FACTORY_INGEST_SECRET` (the panel's Vercel env needs that secret). A missing or wrong secret is rejected. The comparison is constant-time.

```sh
curl -sS -X POST "https://marshal-factory-dougclift.vercel.app/api/jobs/file" \
  -H "authorization: Bearer $FACTORY_INGEST_SECRET" \
  -H "content-type: application/json" \
  -d '{"title":"Show the item count","description":"On the weight sort button.","repo":"owner/name","harness":"Claude Code","runsOn":"modal"}'
```

| Field | Required | Notes |
| --- | --- | --- |
| `title` | yes | 3 to 200 characters |
| `description` | no | up to 10,000 characters |
| `repo` | no | `owner/name` of an enabled target repo. Omitted uses the default repo. |
| `harness` | no | a reported harness's provider id or its display name |
| `runsOn` | no | `mac` (local, on any runner that runs local) or `modal` |
| `machine` | no | a machine's id or display name. Pins the job to that machine and runs it locally. Unknown names are rejected. |
| `requestId` | no | a UUID. Sending the same one again returns the first job. |

`201` body:

```json
{ "key": "MF-12", "id": "queue:…", "url": "https://marshal-factory-dougclift.vercel.app/?job=MF-12" }
```

`key` is the job key and the branch name (`factory/MF-12`). `id` is the job id the runner writes when it claims the row. `url` opens the panel. The runner claims the job within a few seconds (a claim intent is recorded; the 90 second timer is the backstop) and then launches it on the Mac or in Modal like any other job. No Linear call is made.

## The queue

The queue is a task source stored in this factory's Postgres (`queue_items`, migration 0040). Filing inserts a Todo row with the `factory` label and a key `MF-<n>`. The runner's claim reads it through the same source adapter as Linear, launches on `factory/MF-<n>`, opens the PR, and writes stage comments back onto the row. Retry, answers, and the panel's status all use that row. `bun run db:migrate` creates the tables; the Vercel build runs it too.

Set `FACTORY_LABEL` on the panel and in the runner's environment when `factory.label` in the config is not `factory`. The two have to match, or the runner will not claim what the panel filed.

## Settings

The panel's **Settings** page holds what you change day to day: the default harness and model for new jobs, where jobs run (**Run jobs on**: this Mac or Modal, with what's still missing for Modal), and Slack notifications. Per repo, **Repositories** sets merging (**Off**, **Trial** or **Merge when confident**) and **Require Bugbot review**. A ticket's **Harness**, **Runs on** and **Repository** labels beat the repo's defaults, which beat Settings.

The optional `factory` object in `~/.config/marshal-factory/config.json` overrides these defaults (from `lib/config.ts`):

- `teamKey` (`FAC`) and `label` (`factory`): the Linear team and label to work on.
- `maxInFlight` (4): how many jobs this Mac runs at once.
- `provider` (`claudeAgent`) and `model` (`claude-opus-5-5`): what new threads run on.
- `stuckAfterMinutes` (30) and `failAfterNudgeMinutes` (30): when a quiet job gets nudged, and when it fails after the nudge.
- `cleanupGraceDays` (3): how long a failed job's worktree is kept.

[docs/operations.md](docs/operations.md) lists the rest.

If you change the team key or label, also change them in the ingest Function (`FACTORY_TEAM_KEY` and `FACTORY_LABEL`, with the `neon functions deploy` command from step 6) and in Vercel. Then rerun `bun scripts/install-webhooks.ts` for a new team.

## Running jobs in Modal sandboxes

Instead of this Mac's T3, the runner can start each job in its own Modal sandbox, so jobs don't share a machine and more of them run at once. On the runner Mac:

```sh
uv tool install modal && modal token new
bun scripts/sandbox-image.ts
mkdir -p ~/.codex-factory-1 && CODEX_HOME=~/.codex-factory-1 codex login --device-auth
```

For Claude Code jobs, run `claude setup-token`, add the token as `CLAUDE_CODE_OAUTH_TOKEN=...` to `.env.local` in the live checkout and restart the runner. Without it, those jobs run on Codex. A Claude Code job needs no Codex login, so with the token any number of them run side by side, up to `factory.sandbox.maxParallel` (4) and `factory.maxInFlight` (4). Each Codex job holds one Codex login while its sandbox runs: each extra login (`~/.codex-factory-2` and so on) lets one more Codex sandbox run; list them in `factory.sandbox.codexSlots`.

Then set **Run jobs on** to Modal in the panel's Settings, which shows anything still missing. A job waiting for review or an answer hibernates to a snapshot after five minutes and wakes when it is needed, so it does not pay for a running sandbox while it waits. Claude Code and Codex jobs show stages and cost; other harnesses show neither. The runner rebuilds the image itself when a pin or a playbook changes; rebuild it by hand (`bun scripts/sandbox-image.ts`) when you change the hooks or the MCP server. [docs/operations.md](docs/operations.md#running-jobs-in-modal-sandboxes) has the details, including opening a sandboxed job in T3.

## Runner on a Linux VPS

A Linux VPS can run the runner instead of a Mac. The setup this section is for is Modal-only: the VPS claims jobs and starts the Modal sandboxes, and T3 runs inside those sandboxes. The Mac install above is unchanged.

Run it as a normal user, not root. Install git, curl, unzip, jq, openssl, [Bun](https://bun.sh) and Node 22. Install the Modal CLI with `uv tool install modal`. Install the GitHub CLI (`gh`) only when jobs will run on this machine; a Modal sandbox brings its own.

Clone your fork to `~/code/marshal-factory` and keep that checkout on `main`. It is the live checkout, same as on a Mac:

```sh
git clone https://github.com/<you>/marshal-factory.git ~/code/marshal-factory
cd ~/code/marshal-factory
git checkout main
bun install
```

Copy these from the machine that already runs the factory, and keep each one mode 600:

- `.env.local` in the checkout
- `~/.config/marshal-factory/config.json`
- `~/.config/marshal-factory/github-app.json`

```sh
mkdir -p ~/.config/marshal-factory
chmod 600 .env.local ~/.config/marshal-factory/config.json ~/.config/marshal-factory/github-app.json
```

Give this machine its own `factory.machineId`. With none set, the runner uses `/etc/machine-id` and shows the host name in the panel. Never reuse another machine's id. A copied config, or a disk image that still has the other machine's `/etc/machine-id`, makes two runners write one `machines` row and both act on the jobs that row owns.

```sh
jq '.factory.machineId = "replace-with-a-new-id"' ~/.config/marshal-factory/config.json > /tmp/marshal-factory-config.json
mv /tmp/marshal-factory-config.json ~/.config/marshal-factory/config.json
chmod 600 ~/.config/marshal-factory/config.json
```

Set `factory.executions` to `["modal"]` as well. The default is `["local", "modal"]`, so this machine would also claim jobs that run locally: one pinned to a machine, and one that Settings or a Runs on label send to local. `["modal"]` leaves those for a runner that can run local. An untargeted Modal job can still be claimed here.

```sh
jq '.factory.executions = ["modal"]' ~/.config/marshal-factory/config.json > /tmp/marshal-factory-config.json
mv /tmp/marshal-factory-config.json ~/.config/marshal-factory/config.json
chmod 600 ~/.config/marshal-factory/config.json
```

Then, on this machine:

```sh
modal token new
bun scripts/sandbox-image.ts
```

`modal token new` writes `~/.modal.toml`. The service sets `HOME`, so the runner finds the token. For Claude Code jobs, add `CLAUDE_CODE_OAUTH_TOKEN=...` to `.env.local`. The unit carries no secrets; the runner loads `.env.local` from the checkout when it starts. After changing `.env.local`, restart the service (`systemctl --user restart marshal-factory-runner.service`, or `--uninstall` and install again). Running the installer again, with the unit file unchanged, leaves the process running.

In the panel, keep **Run jobs on** set to Modal. Every runner reads that one settings row. Leave `factory.repos` empty unless T3 is running on this VPS. Repos the factory already knows stay available for Modal jobs; `factory.repos` lists only this machine's local checkouts.

`planLaunch` in `runner/overrides.ts` is why the list matters, for a runner whose `factory.executions` includes `local`. The saved place defaults to this machine's T3. When Settings send a job to local and this machine has no checkout of the repo, the job moves to Modal if Modal can launch. A ticket labeled Local still moves to Modal when T3 is down and Modal can launch. With `factory.executions` set to `["modal"]`, those jobs are not claimed here at all: they stay for a runner that runs locally. A job with no Runs on label does not move, once a checkout is listed: a down T3 leaves that job local, and the launch fails. A plain clone in `factory.repos` is still what a post-merge revert uses. `runner/post-merge.ts` reverts from a worktree of that checkout, and the clone does not take launches off Modal while **Run jobs on** is Modal. List a clone when you want reverts from this machine, and do that only while local launch is not the selected place. With T3 not running here, an empty `factory.repos` and **Run jobs on** left on Modal is the Modal-only setup.

Hooks in a target repo point at the checkout that wired them. `lib/target-wiring.ts` writes those paths absolutely into the repo's hooks and MCP server. A Modal sandbox points the paths at the copy of the factory in the image. A local job runs the hooks at the written path, which on a VPS is still the original machine's checkout. That matters only for local jobs.

Install and start the runner:

```sh
bun scripts/install-runner.ts
sudo loginctl enable-linger "$USER"
tail -f ~/.local/state/marshal-factory/runner.log
```

This writes `~/.config/systemd/user/marshal-factory-runner.service`. It runs `bun runner/index.ts` with the checkout as its working directory, restarts 10 seconds after the process exits, and appends stdout and stderr to `~/.local/state/marshal-factory/runner.log`. The unit's environment is `PATH`, `HOME` and, when `t3` is installed, `T3CODE_CLI_PATH`, the same three the Mac's LaunchAgent sets. Running the installer again reloads systemd and enables the service, and restarts the process only when the unit file changed. `--uninstall` stops, disables and removes the runner unit, and leaves `marshal-factory-t3.service` running so a rollout can stop and start the runner without dropping `t3 serve`. `--uninstall --with-t3` removes that unit too. If linger is off, the installer prints `sudo loginctl enable-linger $USER`. Linger keeps the user service running after you log out. Within a minute the log shows a heartbeat, and the VPS appears under **Machines**.

To run jobs on the VPS itself, install T3 and add its service:

```sh
bun scripts/install-runner.ts --with-t3
```

That also installs `marshal-factory-t3.service`, which runs `t3 serve --host 127.0.0.1` and logs to `~/.local/state/marshal-factory/t3.log`. Then list the checkouts in `factory.repos`. Leave this off for a Modal-only VPS.

`bun scripts/rollout.ts` in this checkout stops and starts the systemd user service the same way it does the LaunchAgent on a Mac, and reads `~/.local/state/marshal-factory/runner.log`.

Before you shut the old machine down, wait until it has no claimed job left. A job stays with the machine that claimed it (`jobs.machine_id`): its thread, its sandbox and a revert of its merge stay there. The VPS claims queued jobs that no machine holds yet. Stop the old runner once its in-flight jobs have finished. `bun scripts/rollout.ts` on that machine refuses while any are in flight, and `--wait` waits for them. With the old runner still up, both machines claim new jobs that are not pinned to one machine and that each runner's `factory.executions` allows.

## Connecting Slack

Optional. With Slack connected, the runner messages you when a job needs you or the factory merges or reverts on its own, and edits the message once it's resolved. The messages carry the Inbox's buttons (**Approve and merge**, **Request changes**, **Answer**, **Close**, **Dismiss**), and `/factory` or the **Send to factory** message shortcut files new jobs. Only your own Slack account can act.

1. Create the app at [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, with the manifest in [docs/operations.md](docs/operations.md#slack-notifications), then install it to your workspace. The manifest's panel URL is `marshal-factory-dougclift.vercel.app`.
2. Add three values to `.env.local` in the live checkout: `SLACK_BOT_TOKEN` (**OAuth & Permissions** → Bot User OAuth Token), `SLACK_SIGNING_SECRET` (**Basic Information** → App Credentials) and `SLACK_OWNER_USER_ID` (your Slack profile → ⋯ → **Copy member ID**).
3. Add the same three to the panel's Vercel environment for Production, redeploy, and restart the runner (`bun scripts/install-runner.ts --uninstall && bun scripts/install-runner.ts`).
4. In the panel's **Settings** → **Notifications**, pick your DMs or a channel, the events you want and optional quiet hours, then **Send test message**.

[docs/operations.md](docs/operations.md#slack-notifications) has the details.

## Updating

After a merge to `main`, update the live checkout with:

```sh
bun scripts/rollout.ts
```

It waits for Vercel's production deploy (which runs the migrations), stops the runner, pulls, migrates, redeploys the ingest Function and rebuilds the sandbox image when they changed, and starts the runner again. [docs/operations.md](docs/operations.md#rolling-out-a-merge) has the steps and the opt-in canary.

## Troubleshooting

- **Start with the runner log**: `~/Library/Logs/marshal-factory/runner.log`. Each line is one JSON event. Errors name the step that failed.
- **An issue isn't picked up.** For a Linear issue, check that it is in your team (`teamKey`), has the label, and is in an unstarted state such as Todo, and that the Linear webhook exists under Linear → Settings → API. For a queue job, check that its row is still Todo and still has the factory label (`factory`, unless `FACTORY_LABEL` or `factory.label` says otherwise). Either way, **Repositories** needs at least one repo or `factory.repos` must not be empty. The runner also polls every 90 seconds, so a missed wake-up only delays the job.
- **Machine shows offline.** The runner isn't sending heartbeats. Check `launchctl list | grep marshal-factory`, then the log. Run `bun runner/index.ts --once` in the live checkout to do one pass by hand and see its output.
- **Sign-up fails with "Invalid origin."** Neon Auth only accepts sign-ups from its trusted domains, and the panel's domain isn't one of them. Run `neon neon-auth domain add https://<your panel domain> --branch main`, then sign up again. See [the owner account steps](docs/operations.md#panel-access-and-deploys).
- **The board has no live updates.** Check the three Realtime variables in Vercel. Previews never subscribe to live updates; only production does. An origin missing from `preview.realtime.allowedOrigins` in `neon.ts` is refused until it is added there and `neon deploy` is run.
- **A run has no stages or costs.** The target repo's hooks aren't reaching ingest. Check that the files from `install-target` are on the repo's `main`, and that `secret` in your config equals `FACTORY_INGEST_SECRET` in the Function.
- **You moved the live checkout.** The hooks and the LaunchAgent hold its old path. Run `install-target` for each repo and `install-runner` again.
- **Repositories shows a repo as failed with "The image build was still running after 45 minutes, so the factory stopped it."** The runner never saw the warm-image build finish, for example because a rollout restarted it while the build ran. Until a new image lands, that repo's jobs run without a warm image (the runner logs `sandbox:warm-image-outdated`), so they clone and install from scratch. Press **Rebuild image** on the repo's Repositories entry; the image builds in a few minutes and the repo returns to Ready. See Freshness in [Onboarding a repository](docs/operations.md#onboarding-a-repository).

## Developing

Work in a separate clone or worktree, never in the live checkout. Run `bun dev` for the panel against a Neon branch of your own, not `main`.

`bun run test:regressions` runs every `scripts/*-regressions.ts` against a throwaway Neon branch made from production. It deletes the branch when the run ends. Pass a prefix to run a subset, for example `bun run test:regressions ingest`. During a test run, the real Linear client, the GitHub App and `t3` commands refuse to run, so a test can't touch real work.

## Further reading

- [docs/operations.md](docs/operations.md): how each part behaves, including the runner, write-back, retries, spend, cleanup, the watchdog, sign-in and deploys.
- [playbooks/factory.md](playbooks/factory.md): what each factory thread is told to do.
- [docs/research/](docs/research/): background reports from the initial investigation.
