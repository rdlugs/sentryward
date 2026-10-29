<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="client/public/sentryward-logo-dark.png">
    <img src="client/public/sentryward-logo-light.png" alt="Sentryward" width="360">
  </picture>
</h1>

<p align="center">
  <b>Self-hosted AI code review for GitHub pull requests and GitLab merge requests.</b>
</p>

<p align="center">
  <a href="https://github.com/rdlugs/sentryward/actions/workflows/ci.yml"><img src="https://github.com/rdlugs/sentryward/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/rdlugs/sentryward/releases"><img src="https://img.shields.io/github/v/release/rdlugs/sentryward?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#review-configuration">Configuration</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/rdlugs/sentryward/discussions">Discussions</a>
</p>

Sentryward is an AI code reviewer for GitHub pull requests and GitLab merge requests.
Connect repositories, choose a model provider or Ollama, and run manual or
automatic reviews with inline findings, walkthroughs, and commit statuses. The
dashboard tracks reviews and findings across runs.

> [!WARNING]
> Sentryward is pre-1.0: minor releases may include breaking changes. AI findings
> need human verification and can miss problems or report false positives.
> `docker-compose.yml` is for development; to host an instance, see [Deploying](#deploying).

## Contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Getting started](#getting-started): [runtime environment](#docker-runtime-environment), [users and invites](#users-and-invites), [workspaces and teams](#workspaces-and-teams), [first review](#run-your-first-review), [troubleshooting](#troubleshooting)
- [Deploying](#deploying)
- [Forge connections](#forge-connections), [publishing](#publishing-to-the-forge), [automatic reviews](#automatic-reviews), [notifications](#notifications)
- [Review configuration](#review-configuration): [LLM connections](#llm-connections-and-custom-endpoints), [Ollama](#ollama), [`.sentryward.yaml`](#sentrywardyaml-reference), [review rules](#review-rules)
- [Privacy and data](#privacy-and-data): [what is stored](#what-is-stored), [what leaves the server](#what-leaves-the-server), [retention](#retention), [provider restrictions](#provider-and-host-restrictions), [audit log](#audit-log)
- [API](#api)
- [Development](#development)
- [Contributing and license](#contributing-and-license)

## Highlights

- **Self-hosted, bring your own model:** Anthropic, OpenAI, Google, a compatible
  proxy on a [custom host](#llm-connections-and-custom-endpoints), or a local
  [Ollama](#ollama) model.
- **GitHub and GitLab:** a GitHub App, plus GitLab.com or self-hosted GitLab.
- **Reviews where you work:** inline findings with suggestions, one summary
  comment, and a `sentryward/review` commit status.
- **Manual or automatic:** submit a PR/MR URL, review on webhooks, or comment
  `/sentryward review`.
- **Per-repository config:** dashboard settings, overridable by a
  [`.sentryward.yaml`](#review-configuration) in the repository.
- **Findings across runs:** a later run never posts the same finding twice.
  Ignore findings as false positives, intentional, or fix later, and track the
  false-positive rate on the dashboard, broken down by category, severity and
  model with a pointer to the setting that would quiet the noisiest ones.
- **Teams:** share connections, repositories, reviews and model keys in team
  workspaces, with owner, admin and member roles and one-time invite links,
  managed from **Team settings** in the workspace switcher.

## Quick start

```sh
git clone https://github.com/rdlugs/sentryward.git && cd sentryward
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY in .env, each with: openssl rand -hex 32
docker compose up --build
```

Open http://localhost:5173, register, then follow
[Run your first review](#run-your-first-review). The full setup is in
[Getting started](#getting-started).

## How it works

The `worker` container runs review jobs: it fetches the PR/MR, resolves the review configuration, sends the diff to the configured model in one or more passes (plus an optional walkthrough), validates the findings, re-checks blocking ones with a second model call (`review.verify`; `llm.walkthrough_model` and `llm.verify_model` can point those two calls at a different model than the review passes) and stores the result on the job. Model keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`, unless the repository's workspace has stored its own. The worker polls the `review_jobs` table (claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run side by side); tune it with `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_LOCK_TIMEOUT_MS`, `WORKER_MAX_ATTEMPTS`, `WORKER_HEARTBEAT_INTERVAL_MS` and `WORKER_MAX_RUN_MS`. While a job runs the worker refreshes its lock every `WORKER_HEARTBEAT_INTERVAL_MS` (default 60s, keep it well below `WORKER_LOCK_TIMEOUT_MS`), so a long-but-healthy review is not reclaimed as a dead worker (the server refuses to start otherwise). `WORKER_MAX_RUN_MS` (default 30m) is the longest a review may take: a run past it is failed, healthy or not, and its slot freed, so raise it for repositories with very large reviews. A run that loses its job this way, or to stale-lock recovery, stops and publishes nothing more.

`REVIEW_RETENTION_DAYS` bounds how long reviews keep their bulky data (unset, the default, keeps everything). Once an hour the worker deletes superseded, skipped and cancelled reviews that finished more than that many days ago, and clears the stored result, resolved configuration and publication record of older completed, partial and failed ones. Those keep their row, status, verdict and summary, so the reviews list, stats and findings list are unaffected, while the review page says the full result has expired and its markdown export answers `410`. The newest completed or partial review of each change is never cleared, however old, so its findings keep their full details, replies on their inline threads can still be answered and the next push still gets an incremental review. A finding last reported by an older, cleared review (for example one ignored a while ago) keeps its row but loses its full details. Failed reviews that stored nothing are left as they are, so they still show their error. Pruning works in batches of 500 rows so it never holds long locks. Because cancelled reviews are deleted, a change cancelled or closed more than the window ago and later reopened at the same commit is reviewed again. An instance admin can set the period from the dashboard instead, which takes precedence over the environment variable, and each workspace can shorten it; see [Retention](#retention).

## Getting started

Requires Docker with Compose.

```sh
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY, each with: openssl rand -hex 32
# keep NODE_ENV=development for the local HTTP setup
docker compose up --build
```

The initial command builds the client and server dependency images. For subsequent
starts, use `docker compose up`. Source changes are bind-mounted into the containers
and picked up by the development watchers without rebuilding. Rebuild the images
when either `package.json` or `package-lock.json` changes.

- Web client: http://localhost:5173 (`CLIENT_HOST_PORT`)
- API: http://localhost:4000/api (`API_HOST_PORT`); the client proxies `/api` to it
- Postgres: localhost:5433 (`DB_HOST_PORT`)

If you change `CLIENT_HOST_PORT`, update `CLIENT_ORIGIN` to match.

Migrations are applied automatically when the `server` container starts.

Check startup without opening a browser:

```sh
curl --fail http://localhost:4000/api/health
```

Use your configured `API_HOST_PORT` if it differs. A ready API returns
`{"status":"ok"}`. The database lives in a persistent Docker volume; rebuilding
images does not delete it.

### Docker runtime environment

Set `NODE_ENV` in `.env`; the API and worker both use it, defaulting to
`development` when omitted or empty. Recreate affected services after changing it:

```sh
docker compose up -d server worker
```

| Value | API and worker behavior |
| ----- | ----------------------- |
| `development` | Local HTTP authentication cookies; local/private forge hosts are allowed. |
| `production` | Secure authentication cookies, and existing HTTPS/public-address checks for self-hosted forge hosts. Use an HTTPS client origin. |

`test` is reserved for automated tests; the server test script sets it explicitly.
Other values fail startup validation. `production` does not switch Docker
commands, disable watchers, build/serve the frontend, or provide HTTPS. The client
still runs Vite's development server, so do not expose this Compose setup publicly;
use the production image instead (see [Deploying](#deploying)).

### Users and invites

The first account registered on an instance becomes its **admin**, and so does
the oldest account on an install that predates roles. Admins see **Users** in the
sidebar, where they can promote or demote admins, remove users and create invite
links. An instance always keeps at least one admin. A user's personal-workspace
connections, repositories and reviews stay private to them; data in a team
workspace is shared with that team's members. Being an admin does not by itself
grant access to either.

`REGISTRATION_MODE` in `.env` controls who can create an account:

| Value | Who can register |
| ----- | ---------------- |
| `open` (default) | Anyone who can reach the client |
| `invite` | Only people with an invite link. A team invite also works here, admitting the new account and placing it in that team |
| `closed` | No new accounts; admins can still create invites, but they cannot register anyone until the mode allows it. Existing signed-in users can still accept a team invite to join a workspace |

The login page only links to sign-up when registration is `open` or the instance
has no accounts yet; invitees register from their invite link.

An invite link works once and expires after 7 days. Adding an email limits the
link to that address. When `SMTP_URL` (for example
`smtp://user:pass@smtp.example.com:587`) and `MAIL_FROM` are set, the link is
also emailed; otherwise copy it from the dialog, which shows it only once.
Resending an emailed invite sends a new link and renews its expiry; the old link
stops working.

### Password resets

"Forgot password?" on the login page emails a reset link when `SMTP_URL` is set.
The request always gets the same answer, so it does not reveal which emails have
accounts. The link works once and expires after 1 hour. Requesting another one
replaces it, but at most one email is sent to an account every 2 minutes. Without
mail, the page tells the user to ask an admin, who can create a link from the
user's actions on the Admin page (it works once, expires after 24 hours and is
shown only once). Admins can do this whether or not mail is set up. An admin's
link replaces any earlier one, and a later emailed request leaves it working.
Whether mail is configured is public, through `GET /api/auth/registration`.

Setting a new password from a link signs the user in and ends every other
session. Changing the password in Settings does the same, keeping only the
current browser signed in.

### Workspaces and teams

Every account has a private **personal workspace**. Anyone can also create a
**team workspace** from the switcher in the sidebar; its forge connections,
repositories, reviews, findings, global review config and LLM keys belong to the
team rather than to one person. The dashboard remembers the workspace you last
used.

| Role | Can |
| ---- | --- |
| `member` | View the team's data, request, rerun and cancel reviews, triage findings, leave the team |
| `admin` | Everything a member can, plus manage connections, repositories, review config and LLM keys, add and remove members, and invite people |
| `owner` | Everything an admin can, plus grant or revoke ownership, rename and delete the team |

A team always keeps at least one owner, so the last owner has to promote someone
else before leaving or deleting their account. The **Team** page (`/workspace`)
lists members, pending invites and settings. Admins can add someone who already
has an account directly (which shows them which emails are registered on the
instance) or invite anyone else with a team invite link.

### Run your first review

1. Open the client URL and register an account. The first account is the admin.
2. In **LLM Connections**, add and verify a model provider key, or configure
   [Ollama](#ollama). External providers may charge for model usage.
3. In **Review settings**, select that connection and a model available to it.
4. In **Repositories**, connect GitLab or install your configured GitHub App using
   the [forge setup](#forge-connections), then add a repository for review.
5. In **Reviews**, submit the URL of an open PR/MR on that repository. The worker
   processes it and the detail page shows results or the reason it failed.

Default publishing can post comments and statuses and update the description.
For an initial evaluation, use a test repository or disable publishing in
Review settings before running the review. Manual reviews do not require an
internet-reachable webhook URL; automatic reviews do.

See the [synthetic review output fixture](server/tests/__snapshots__/review.md)
for a rendered markdown example. It exercises presentation and is not a real
review or evidence of model accuracy.

### Troubleshooting

<details>
<summary>Common setup and review problems</summary>

- **Startup validation fails:** set a JWT secret of at least 32 characters and
  an encryption key of exactly 64 hexadecimal characters. Generate each with
  `openssl rand -hex 32`. Keep the encryption key stable for existing credentials.
- **A port is occupied:** change the corresponding host port in `.env`; changing
  the client port also requires updating `CLIENT_ORIGIN`.
- **Login fails after switching to production:** production cookies require
  HTTPS. Use `development` for the supplied local HTTP setup.
- **GitHub connection is unavailable:** configure the complete GitHub App setup,
  including OAuth installation confirmation.
- **Manual reviews work but automatic ones do not:** check webhook reachability,
  forge permissions, and trigger settings. GitLab hook creation needs Maintainer.
- **A model endpoint is unreachable:** inside Docker, `localhost` refers to the
  container. Use `host.docker.internal` for a service on the host and check its
  listen address and firewall.
- **Database tests cannot find `sentryward_test`:** the Postgres init script runs only
  when the database volume is first initialized. An older volume may need an
  operator-created test database. Do not delete a volume containing needed data.
- **A review is failed or partial:** inspect its detail page and redacted
  `docker compose logs --tail 100 server worker` output for provider, permissions,
  or publishing errors. Never post credentials or private code in an issue.

</details>

## Deploying

The production setup is one image, `ghcr.io/rdlugs/sentryward`, that runs the API,
serves the built dashboard from the same origin, and runs the review worker with
a different command. `docker-compose.prod.yml` runs it with PostgreSQL. It has no
source mounts or dev dependencies, and does not publish the database port. TLS is
left to a reverse proxy you run in front of it.

```sh
cp .env.production.example .env.production
# fill in POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY and your public URL
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Images are published for `linux/amd64` and `linux/arm64` on each release tag.
`SENTRYWARD_VERSION` picks the tag (for example `0.2.0`). `latest` follows
the newest stable release only; pin a version for controlled upgrades.
To build from source instead, set `SENTRYWARD_VERSION` to a local name and run
`docker compose -f docker-compose.prod.yml --env-file .env.production build server`
before `up`.

- **Public URL:** set `CLIENT_ORIGIN` and `API_PUBLIC_URL` to the same `https://`
  URL. The GitHub App's setup URL becomes `<url>/api/connections/github/callback` and
  its webhook URL `<url>/api/webhooks/github`; a GitLab OAuth application's redirect URI
  becomes `<url>/api/connections/gitlab/oauth/callback`; GitLab webhooks use it automatically.
- **Reverse proxy:** the API listens on `127.0.0.1:4000` on the host (`API_BIND`,
  `API_HOST_PORT`). `TRUST_PROXY` (default `1`) is the number of proxies in front,
  so rate limits see client addresses; set it to match your setup. A minimal Caddy
  config, which also obtains the certificate:

  ```
  sentryward.example.com {
      reverse_proxy 127.0.0.1:4000
  }
  ```

- **Registration:** the production example defaults `REGISTRATION_MODE` to `invite`.
  The first account still registers freely and becomes the admin, so create it
  before sharing the URL.
- **Upgrades:** back up the database, change `SENTRYWARD_VERSION`, then run `pull`
  and `up -d` with the same `-f` and `--env-file` flags. The server applies
  migrations before it reports healthy, and the worker starts after it. The old
  worker finishes its in-flight reviews before exiting, and Compose waits up to
  `WORKER_STOP_GRACE_PERIOD` (default `15m`) for it, so an upgrade can pause while
  reviews complete; `stop -t <seconds>` overrides the wait.
- **Backups:** the `pgdata` volume holds everything (for example
  `docker compose -f docker-compose.prod.yml exec db pg_dump -U sentryward sentryward`).
  Back up `ENCRYPTION_KEY` separately and keep it stable: stored forge tokens and
  model keys cannot be decrypted without it. After a key change, API keys show as
  unreadable until they are re-entered, forge connections show as inactive until
  reconnected, and repository webhooks need the repository disabled and enabled again.
- **Model endpoints on the host** (such as Ollama): the production file does not add
  `host.docker.internal`. Add an `extra_hosts` entry to the worker and server if you
  need it.

Read [SECURITY.md](SECURITY.md) before exposing an instance.

## Forge connections

**GitLab**: connect with a personal, project or group access token with the `api` scope and at least Developer access. Self-hosted instances work by entering their host.

GitLab can also connect through OAuth ("Connect with GitLab"), alongside tokens. Register an application on the instance (User, Group or Admin settings, Applications) and put its details in `.env`:

- Redirect URI: `<CLIENT_ORIGIN>/api/connections/gitlab/oauth/callback` (for local development `http://localhost:5173/api/connections/gitlab/oauth/callback`). It goes through the client origin so the browser sends the session cookie with it.
- Scope: `api`. GitLab has no narrower scope that allows posting comments, discussions and commit statuses.
- **Confidential** checked, and **Expire access tokens** on. Sentryward stores the access and refresh tokens encrypted and refreshes the access token shortly before it expires. GitLab rotates the refresh token on every refresh, so refreshes of one connection are serialized; if GitLab refuses one (the application was revoked, the user removed), the connection shows as inactive and reviews fail asking you to reconnect.
- `GITLAB_OAUTH_HOST` (default `gitlab.com`), `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET`. One instance per deployment; tokens still work for any other.

An OAuth connection acts as the person who signed in: reviews, comments and statuses appear under their name, and it can reach what they can. A project or group access token posts as a GitLab bot user instead, so prefer a token when comments should not come from a person. Either way, automatic reviews need Maintainer access (see below).

**GitHub**: create a GitHub App (Settings, Developer settings, GitHub Apps) and put its details in `.env`:

- Setup URL: `http://localhost:5173/api/connections/github/callback`, with **Request user authorization (OAuth) during installation** checked. Sentryward uses that OAuth code to confirm the installing user can actually access the installation.
- Repository permissions: Pull requests (read and write), Contents (read), Commit statuses (read and write), Issues (read), Checks (read), Metadata (read). Issues is used for linked and related issues in the walkthrough; without it those parts are skipped with a warning. Checks is used for [static analysis findings](#static-analysis-findings); without it they are skipped with a warning.
- Copy the App ID, slug, client ID, a client secret and a generated private key into the `GITHUB_APP_*` variables.
- Webhook: URL `<API_PUBLIC_URL>/api/webhooks/github`, a secret in `GITHUB_WEBHOOK_SECRET`, and the events **Pull request**, **Issue comment**, **Pull request review comment** and **Installation**. Review comment events are how [replies to findings](#replying-to-findings) arrive; an App created before they existed needs the event added in its settings.

GitLab automatic reviews need a project webhook, which Sentryward registers when a repository is enabled at `API_PUBLIC_URL`. That takes **Maintainer** access; with only Developer access the repository is enabled for manual reviews and the dashboard says why automatic ones are off. GitLab must be able to reach `API_PUBLIC_URL`; for local development use a tunnel.

In production, self-hosted forge hosts must use https and resolve to public addresses.

## Publishing to the forge

When a review starts, Sentryward posts a "reviewing" summary comment and sets a pending `sentryward/review` commit status. When it finishes it publishes, each step independently:

- **Inline comments** for actionable findings only (GitHub: one review posted as `COMMENT`, never approve or request changes; GitLab: one discussion per finding). Suggestions use each forge's suggestion syntax. Each comment carries a hidden fingerprint, so a later run never posts the same finding twice, even if Sentryward's own records are lost.
- **Resolved threads** (`output.resolve_fixed_threads`, on by default): when a run reviews a file and no longer reports a finding, its inline thread is resolved (GitHub through GraphQL, GitLab by resolving the discussion); if the finding comes back, the thread is reopened, but only when Sentryward resolved it: a thread a person resolved stays resolved. Only threads Sentryward opened, and only for findings whose state changed, are touched. A thread update that fails is retried on later runs until it lands. Ignored findings are left alone.
- **The summary comment**, edited in place: the markdown served by `GET /api/reviews/:id/markdown`. One comment carries both what the change does (the walkthrough, when `output.walkthrough` is on) and what the review found. It ends with a line naming the commit, models and coverage, which `output.review_stats` turns off. With `output.post_summary` off, the walkthrough is posted as a comment of its own. `output.summary_location` is accepted but ignored, and a walkthrough block an earlier version wrote into the description is removed on the next review.
- **The walkthrough's optional parts**, each with its own switch: the review effort estimate (`output.estimate_effort`), a Mermaid sequence diagram of the main flow (`output.sequence_diagrams`), an assessment of how well the change addresses the issues it closes (`output.assess_linked_issues`; "fixes #12" style references on GitHub, GitLab's own closing issues on GitLab) and possibly related issues found by searching the tracker for the title's keywords (`output.related_issues`). Only issues the forge returned are ever shown. The labels and blast radius segments of the walkthrough's meta line can each be hidden too (`output.walkthrough_labels`, `output.walkthrough_blast_radius`); this only changes the comment text, not the native labels below.
- **The high-level summary** (`output.high_level_summary`): release notes by default, or whatever `output.high_level_summary_instructions` asks for. `output.high_level_summary_placement` puts it in the PR/MR description (the default, between hidden markers at the end, replaced on each run and never read back as the author's text) or in the walkthrough.
- **Labels**, when `output.blast_radius_label` or `output.effort_label` is on: the walkthrough's estimates as native labels such as `Large blast radius` or `10-20 Minutes`. A later run swaps a changed estimate's label. GitHub and GitLab only; on GitHub both labels and the cleanup of old description blocks use the Pull requests (write) permission.
- **The commit status**: `success` (pass), `failure` (blocked) or `error` (incomplete; GitLab shows it as `failed`), linking to the review in the dashboard. Branch protection can require it.

Turn the first three off with `output.post_inline`, `output.post_summary` and `output.post_check`, and the walkthrough with `output.walkthrough`. If publishing fails, the review is kept and the job is marked partial with the reason.

## Replying to findings

Reply in the thread of one of Sentryward's inline comments to act on that finding:

- `/sentryward ignore false-positive [note]` or `/sentryward ignore intentional [note]` (at the start of a line; the rest of the line is the note) ignores the finding with that reason, as the dashboard would, and Sentryward acknowledges it in the thread. With `review.suppress_ignored`, later reviews of the change do not raise it again. Reopen it from the findings page.
- Anything else is a question: Sentryward answers once, briefly, from the finding and the code around it at the change's head, using the review model. The reply is treated as untrusted data, never as instructions.

Only people who can push (GitHub owners, members and collaborators; GitLab Developer or above) get a response. Sentryward never answers its own comments, acts on at most 10 replies per PR/MR per hour (the rest are dropped silently) and handles a redelivered event once. Replies are answered by the worker; `triggers.replies` turns them off, read like the rest of the configuration from the change's base revision.

GitHub needs the **Pull request review comment** webhook event: per-repository hooks registered before this existed get it when the repository is disabled and enabled again. GitLab delivers diff thread notes through the note events its hook already subscribes to.

## Automatic reviews

- A PR/MR is reviewed when it opens, reopens, leaves draft or receives new commits. A commit that was already queued or reviewed is never reviewed again, so redelivered webhooks are harmless, and a newer push supersedes a review still waiting in the queue.
- Comment `/sentryward review` on a PR/MR to ask for a review of its current head. Only people who can push (GitHub owners, members and collaborators; GitLab Developer or above) can.
- `triggers.review` picks what is reviewed automatically when it opens, reopens or leaves draft: `manual` (nothing), `published` (the default, drafts skipped) or `all`. `triggers.review_on_push` decides whether new commits are reviewed again, and `triggers.command` turns `/sentryward review` off.
- A review triggered by a push is incremental: only the files the new commits touched since the last completed review are reviewed again (each with its whole PR/MR diff), and that review's findings on the other files are carried over, so they stay open and still count toward the verdict. A force push or rebase, a partial or failed last review, a comparison the forge cannot answer, and manual or `/sentryward review` requests get a full review. `triggers.full_review_on_push` reviews the whole change on every push instead.
- Every review after the first, incremental or full, says in the summary comment what changed since the last one: findings that are **new**, **still open** (reported earlier and still there, including a finding that moved to another file), **reopened** (fixed or invalidated by an earlier run, and reported again), **fixed** (its file was reviewed and the finding is gone) and **invalidated** (its file was renamed, deleted or dropped from the change, or the finding moved, so it no longer applies but was not fixed). Only files are compared, not lines, so code deleted within the same file counts as fixed. A finding counts as moved only when the same problem now appears in a file the change adds or renames, and it is the only one of its kind on both sides; anything looser would turn real fixes into invalidated findings. Each list in the comment shows at most 20 findings, and `output.finding_lifecycle: false` leaves the block out. The findings page filters by the same outcome ("Last review"), and invalidated findings do not count toward the resolution rate.
- `triggers.summary` limits the walkthrough in automatic reviews: `published` (the default) or `manual`, which leaves it to requested reviews.
- Automatic reviews are skipped when the title contains a phrase in `triggers.ignore_titles` (ignoring case), the author or whoever pushed is in `triggers.skip_authors`, the change carries a label in `triggers.skip_labels` (exact and case-sensitive), or the source or target branch name contains an entry of `triggers.skip_source_branches` / `triggers.skip_target_branches`. A manual review or `/sentryward review` is never skipped by these lists.
- All of this is checked by the worker with the full configuration, so a skipped review shows in the dashboard with the reason.
- Older settings keep their meaning: `triggers.on_push: false` reads as `review: manual` and `triggers.drafts: true` as `review: all`, unless the same layer sets `review`.
- Each workspace has at most `WORKER_USER_CONCURRENCY` reviews running at once (the name predates workspaces), and a repository holds at most 10 queued.
- With `triggers.abort_on_close` (the default), closing or merging a PR/MR cancels its queued reviews, and a running review stops: the worker checks the change before it starts, every 15 seconds while it runs (aborting model calls in flight) and before publishing. A cancelled review publishes nothing more, replaces its progress comment with a short "Review cancelled" note and closes its pending commit status as `error`. The webhook decides on queued reviews from the dashboard settings; the worker uses the full configuration, repository file included.
- Turning a repository off (or the GitHub App losing access to it) cancels its queued and running reviews. A running one stops before its next model call or publishing step, and its pending commit status is set to `success` ("Reviews turned off for this repository") so a required check does not stay blocked. Turning the repository back on lets automatic triggers review those heads again.

The worker keeps a small in-memory cache of what a commit fixes: the repository config file at the base revision and the change's diff for a given base and head. Reruns of the same head skip those forge calls; titles, descriptions, labels and state are always read fresh. `review.disable_cache` turns it off. Set in the dashboard it covers every read; set in `.sentryward.yaml` the diff is fetched again once the file has been read.

With `review.file_context` (the default), each review pass also sees read-only code around the diff, read from the head revision: the enclosing function or class of each hunk, the file's imports, the definitions of functions the diff calls through relative imports, and call sites of functions it changes in files the change does not touch. Head files go through the same cache; caller lookups use the forge's code search (GitHub only indexes the default branch, GitLab searches the head) and are never cached. Context only fills what a pass has left once its diff is planned, so it never displaces a hunk or makes a review partial, and a file or search that cannot be read only costs a warning. Findings on context lines are dropped unless `review.full_file` is on.

`review.impact_depth` (1 to 3, default 2; the `fast` profile uses 1) is how many hops of callers that context follows: at 2, a pass also sees who calls the functions that call the changed code, so a changed signature, return shape or thrown error that breaks code further away is visible. Callers of declarations the diff changed or removed are searched first and marked as such, and further hops are the first context to go when a pass is short of room. A review makes at most 8 caller searches in all, the first 5 for names the change itself defines, and does not trace through generic method names such as `run` or `handle`. Findings that report a broken contract list the files of the callers it breaks as **Affected** in the comment.

The walkthrough also flags risky areas next to the blast radius: authorization checks, database writes and schema changes, and API routes the diff defines (calls through HTTP clients such as `axios` or `api` are not routes), plus route handlers and auth modules it reaches through the traced callers. Test files never count. They are found by pattern, given to the walkthrough model, and raise the blast radius it reports (never lower it): any risky area, changed or reached through callers, makes it at least `medium`, and only a removed authorization check makes it `large`. Incremental reviews keep the areas the last review reached through callers. `output.walkthrough_blast_radius` hides them with the blast radius, in the comment and on the dashboard.

## Notifications

Under **Notifications**, workspace admins add targets that hear about finished reviews. Members can see them; only admins add, edit, test or remove them. Each target picks its events:

- **Blocked**: the review found blocking issues.
- **Failed**: the review could not run or finish (no model key, the forge unreachable, the maximum run time or a worker that stopped responding).
- **Completed**: any finished review, blocked or not. Skipped and cancelled reviews never notify.

A target gets one delivery per review, named after the most specific event it listens for (failed, then blocked, then completed). Admins can switch a target off in the list to pause its deliveries while keeping its events, recipients, URL and secret. Pausing drops deliveries rather than holding them: a review that finishes while a target is paused is never sent to it, even after it is switched back on. A paused target shows as switched off, can be filtered by status, and still accepts test deliveries, so it can be checked before it is switched back on. There are three kinds:

- **Webhook**: a `POST` with a JSON body, an `X-Sentryward-Event` header and an `X-Sentryward-Signature: sha256=<hex>` header, the HMAC-SHA256 of the raw body keyed with the signing secret shown once when the target is added. Remove the target and add it again to change the URL or rotate the secret.

  ```json
  {
    "event": "blocked",
    "review": { "id": "...", "url": "https://sentryward.example.com/reviews/...", "status": "completed", "verdict": "blocked", "error": null },
    "repository": { "provider": "github", "fullPath": "acme/api" },
    "change": { "number": 42, "title": "Add login", "url": "https://github.com/acme/api/pull/42" },
    "findings": { "total": 3, "bySeverity": { "major": 1, "minor": 2 } }
  }
  ```

  `change.title`, `change.url` and `findings` are `null` for a review that failed before it ran.
- **Slack**: an incoming-webhook URL, posted a one-line message linking to the review.
- **Email**: chosen members of the workspace, through the configured mail transport (`SMTP_URL`). Members who leave are no longer emailed.

**Send test** posts a sample (`"event": "test"`) and reports the outcome. Deliveries are best effort: the worker sends them once a review reaches its final status, a failed delivery is logged (`[notify] ...`) and never changes the review, and nothing is retried. URLs are stored encrypted, and only their host is ever shown again. In production a URL must be https and resolve only to public addresses, the same rule as self-hosted forge hosts, checked when the target is saved and again before each delivery; redirects are not followed.

## Review configuration

Settings resolve in this order, highest first:

1. Overrides from whatever triggered the review
2. `.sentryward.yaml` (or `.sentryward.yml`; the first found wins, they are not merged) in the repository, read from the PR's **base** revision so a change cannot loosen its own review
3. Repository settings saved in the dashboard (ignored while the repository follows the global config, which is the default for new repositories)
4. The global config saved on the Review settings page, shared by all of a user's repositories
5. The selected profile: `balanced` (default), `fast`, `strict`, `security`
6. Built-in defaults

A field set explicitly in any layer beats the profile. An invalid repository file is ignored as a whole and reported as a warning; the review still runs. The file cannot hold API keys, tokens or endpoints.

### LLM connections and custom endpoints

Add and verify provider credentials in LLM Connections, then select one in Review settings > LLM. Global configuration requires a connection; a repository can inherit it or select another saved connection. The selection is a live reference, so replacing its key or changing its custom host updates every configuration that uses it.

A connection with a custom host sends every model call to that compatible proxy. The model's provider prefix still picks the request format (`openai/` uses chat completions), and the rest of the id is passed through as is, slashes and parentheses included. Without a custom host, every configured model must use the selected connection's provider.

To check a model before relying on it, choose **Test model** in a connection's actions menu. It runs one short generation with the stored credential, the same way a review would, and reports the response time and token usage, or why it failed: the key was rejected, the host does not serve that model, the host could not be reached, or the model did not answer in the JSON format reviews need. The test uses a small amount of the connection's quota.

For 9router, save its key and host under OpenAI in LLM Connections, select the OpenAI connection in Review settings > LLM, and use a model such as `openai/cx/gpt-5.6-sol(medium)`.

The worker runs in a container, where `localhost` is the container itself; `host.docker.internal` reaches a proxy running on the host.

### Model prices and benchmarks

Review costs are estimates worked out when a review runs, from a built-in price table. Under **Model prices** on the LLM Connections page, workspace admins can set their own price for a model (USD per million tokens for input and output, optionally cache reads, cache writes and reasoning), keyed by `provider/model` or by the id without its provider prefix (for a router id such as `openai/cx/gpt-5.6-sol`, `cx/gpt-5.6-sol` or `gpt-5.6-sol`; the longer match wins). A saved price's model id is fixed: to rename one, remove it and add it again. A workspace price wins over the built-in one; Ollama models cost nothing unless priced. A model neither prices is shown with an unknown cost rather than $0, and the card lists the models recent reviews called that have no price. Prices apply to reviews from then on; past reviews keep the cost they recorded.

The **Benchmarks** page compares models over a period, optionally for one repository: cost (total and per review), tokens and mean call time per model; cost, median review duration and the duplicate rate (findings dropped as repeats of another) per repository; and, per language and per category, how each model's findings turned out (confirmed: resolved by a later run; false positive: dismissed as one), naming the best model among those with at least five decided findings. Confirmed and false-positive rates are over decided findings (confirmed plus false positives), as in the findings calibration stats, so findings still open don't count against a model. Cost per review is over the reviews that called a model.

### Model capabilities

Thinking and agentic context depend on what a model supports on the endpoint that serves it, and that differs per model even on one endpoint: not every native Anthropic, OpenAI or Google model takes thinking options, Ollama models differ in tool and thinking support, and proxies (9router, OmniRoute, LiteLLM, OpenRouter and the like) differ in whether they forward thinking options, translate them between wire formats or pass tool calls through. Sentryward records, per connection and model, whether **thinking** works (through the provider's options, by a model that thinks by itself, or not at all) and whether **tools** work:

- **Probe.** A passing **Test model** also sends two tiny calls, one with thinking options and one with a trivial tool, and stores what each did. A review that needs thinking or tools probes a model the first time it is used on an endpoint, keyed models from the server environment included. Probe tokens are recorded in the review's usage as `probe` calls.
- **Runtime fallback.** A call that the endpoint rejects with a 400 naming thinking or tool parameters is retried once without them; thinking that comes back with no reasoning is noted as ignored; an agentic pass that gets plain text instead of tool calls is read as a static one. Each records a review warning and updates the stored capability, so a review never fails because a model lacks thinking or tools.
- **Defaults.** Official APIs start from a built-in table of model families; Ollama and custom hosts start unknown. Detection overrules the table.

Choose **Capabilities** in a connection's actions menu to see what was found. When detection is wrong, set **Thinking support** and **Tool support** in Review settings > LLM. Like endpoints, these settings exist only in the dashboard: a repository file cannot change how credentials and endpoints are used.

### Thinking and agentic context

`llm.thinking` (`off`, `low`, `medium`, `high`) lets review passes reason before answering. Each level maps to the provider's own option: an Anthropic thinking budget of 2,000, 8,000 or 24,000 tokens, an OpenAI reasoning effort of the same name, or a Google thinking budget. The budget is added on top of `max_tokens` (Anthropic counts thinking inside it), temperature is not sent while thinking is on, and the prompt ceiling leaves room for both. `llm.verify_thinking` sets the verifier's level separately (`null` uses `thinking`); the walkthrough never thinks. The `strict` profile uses `high` and `fast` uses `off`.

`review.context: agentic` lets each pass read more of the repository before it reports. A pass starts from the same diff and gathered context as a static one, and may call `read_file` (at most 400 lines a call, at the change's head revision) and `search_code` (shared by the whole review, since GitHub rate-limits code search), then reports through a `report_findings` tool. `review.agent` caps the loop: `max_steps` (8), `max_tool_tokens` (30,000 per pass) and `max_searches` (5 per review); the last step can only report. What a pass read is shown to the verifier, and usage records each pass's steps and tool calls. Tool results are content from the change under review, so the tools are read-only, scoped to the repository at the head revision, and their output is marked as untrusted data in the prompt. A model or endpoint without tool support falls back to static context with a warning.

### Ollama

Add Ollama under LLM Connections and enter its OpenAI-compatible base URL. For Ollama running on the Docker host, use `http://host.docker.internal:11434/v1`. The API key is optional. Select the Ollama connection in Review settings > LLM and use the `ollama/<model>` form, for example `ollama/qwen3`.

### `.sentryward.yaml` reference

Every key is optional. Values shown are examples, not all defaults.

<details open>
<summary>Full example</summary>

```yaml
# .sentryward.yaml - every key is optional
profile: balanced
llm:
  model: anthropic/claude-sonnet-5-5   # provider/model: anthropic, openai or google
  fallback_models: []
  walkthrough_model: null   # model for the walkthrough; null uses model
  verify_model: null        # model for review.verify; null uses model (fallbacks are shared)
  temperature: 0.2
  max_tokens: 8000
  thinking: off             # off | low | medium | high: reasoning budget for review passes
  verify_thinking: null     # thinking for review.verify; null uses thinking
review:
  categories: [security, bug, performance, logic, reliability]
  severity_floor: minor     # what is reported
  block_on: critical        # what fails the verdict and the commit status
  max_findings: 25
  max_chunks: 12
  min_confidence: 0.5
  require_evidence: true    # unproven critical/major findings are demoted
  suppress_ignored: true    # don't re-report findings this team dismissed as false positive/intentional
  full_file: false          # allow findings on lines the change did not touch
  committable_suggestions: true
  disable_cache: false      # fetch the diff and config file fresh on every run
  file_context: true        # show passes the surrounding code, definitions and callers
  impact_depth: 2           # hops of callers to follow from changed code, 1-3 (fast profile: 1)
  verify: blocking          # off | blocking | all: re-check findings with a second model call;
                            # refuted ones are dropped, uncertain ones demoted (fast profile: off)
  tool_findings: true       # report static analysis results already on the forge as findings
  tool_findings_block: false  # let those findings reach block_on and fail the verdict
  context: static           # static | agentic: let passes read files and search code through tools
  agent:                    # caps for agentic passes
    max_steps: 8            # model calls per pass, the final report included
    max_tool_tokens: 30000  # what tools may return in one pass
    max_searches: 5         # code searches across the whole review
output:
  walkthrough: true
  post_inline: true
  post_summary: true
  post_check: true
  resolve_fixed_threads: true  # resolve a finding's inline thread once it is fixed
  finding_counts: true      # the findings-count line under the verdict
  finding_lifecycle: true   # what changed since the last review (new, fixed, ...)
  review_stats: true        # the commit/models/coverage line under the summary
  agent_prompts: true       # a prompt for AI agents in each actionable inline comment
  agent_prompt_all: true    # one prompt for every finding in the summary comment
  blast_radius_label: false # e.g. "Large blast radius"
  effort_label: false       # e.g. "10-20 Minutes"
  estimate_effort: true     # review effort in the walkthrough
  walkthrough_labels: true  # the labels segment in the walkthrough (text, not native labels)
  walkthrough_blast_radius: true  # the blast radius segment in the walkthrough
  sequence_diagrams: true   # Mermaid sequence diagram in the walkthrough
  assess_linked_issues: true
  related_issues: true
  high_level_summary: true
  high_level_summary_placement: description   # description | walkthrough
  high_level_summary_instructions: ""         # empty: release notes
triggers:
  review: published         # manual | published | all (drafts too)
  review_on_push: true      # review new commits pushed to an open PR/MR
  full_review_on_push: false  # on push, review every file, not only those the new commits touched
  summary: published        # manual | published: walkthrough in automatic reviews
  command: true             # allow "/sentryward review" in a comment
  replies: true             # answer replies on Sentryward's inline comments, and "/sentryward ignore"
  abort_on_close: true      # stop a review when its PR/MR is closed or merged
  ignore_titles: ["WIP"]    # title contains, ignoring case
  skip_authors: ["dependabot[bot]"]
  skip_labels: ["no-review"]          # exact, case-sensitive
  skip_source_branches: ["release/"]  # branch name contains
  skip_target_branches: []
ignore_paths: ["**/*.lock", "**/dist/**"]   # replaces the default list
instructions: "Controllers stay thin; business logic lives in services."
language_instructions:
  typescript: "Strict mode; no any."
rules:                      # team rules, added to the dashboard ones, see "Review rules" below
  - id: no-db-in-controllers
    description: Controllers must not import Prisma directly; go through services.
    severity: major
    paths: ["server/src/controllers/**"]
    pattern: 'from ["'']@prisma/client'   # optional: checked without a model
  - id: money-in-cents
    description: Store and pass money as integer cents, never floats.
    severity: major
    category: logic
    good: |
      const total = priceCents * quantity
    bad: |
      const total = price * 1.0 * quantity
```

</details>

### Review rules

`rules` states a team's conventions once, with a severity, so every review checks them the same way: architecture boundaries, security requirements, naming, approved or forbidden libraries, business rules. Each rule takes:

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits, `.`, `-` and `_`, unique in the file. Shown on every finding and in the dashboard. |
| `description` | yes | What the rule requires, up to 1000 characters. For a rule with a `pattern`, its first sentence is the finding's title; a violation the model reports keeps the model's own title. |
| `severity` | yes | `critical`, `major`, `minor` or `info`. A violation blocks when it reaches `review.block_on`, and is reported only at or above `review.severity_floor`. |
| `category` | no | Files the finding, default `maintainability`. Rule findings are reported whatever `review.categories` holds. |
| `paths` | no | Globs the rule applies to; every reviewed file when absent. A violation the model reports under a rule that does not cover its file is dropped (`rule_mismatch`). |
| `pattern` | no | A regular expression (up to 300 characters) checked without a model. RE2 syntax: like JavaScript, but without backreferences or lookarounds, so matching always takes linear time. |
| `good`, `bad` | no | Compliant and violating examples, up to 2000 characters each. |

- **With a `pattern`**, the rule is checked against every added line of the files it covers (lines over 2000 characters are skipped), so the same diff always gives the same findings. It is never shown to the model and is not re-checked by `review.verify`.
- **Without one**, the rule is given to the model with its examples, and a violation it reports is filed under the rule with the rule's severity. These still go through `require_evidence` and `verify` like any model finding. Their text (ids, paths, descriptions and examples) is capped at 16000 characters in total.

Both kinds are reported with source `rule` and the rule's id, count towards `max_findings`, and can be dismissed like any finding. The Findings page's False positives tab lists found and false-positive counts per rule. Rules are read from the base revision like the rest of the file, so a pull request cannot loosen the rules it is reviewed against. An invalid rule (a pattern that does not compile, a duplicate id) makes the whole file invalid, as with any other setting.

Rules can also be set in the dashboard, on the Review settings page's Guidance tab: in the global config, so they apply to every repository in the workspace, and in a repository's settings. Unlike other lists, rules from each layer are combined instead of replacing each other, in the order global config, repository settings, `.sentryward.yaml`:

- A layer can add rules but never remove or override one from a layer before it. A rule whose id is already set is ignored, the earlier rule applies, and the review lists a warning (for example, a file rule reusing a workspace rule's id). A pull request can therefore not loosen workspace rules either.
- The limits (50 rules, 16000 characters of model-checked rule text) apply to the combined list. If a layer's rules would go past them, that layer's rules are all left out, with a warning, and the earlier layers still apply.
- Saving repository settings is refused when their rules clash with a global rule or would not fit beside the global rules. The global config lists, as warnings, repositories whose saved rules it leaves out.
- Dashboard rules (global config and repository settings) are held to the `severity_floor` and `min_confidence` the dashboard layers resolve to, profile included. A `.sentryward.yaml` or trigger can lower them for those rules but not raise them, so a repository cannot quiet workspace rules that way. Their patterns also run on files that only the file's `ignore_paths` leaves out; model-checked dashboard rules are not, since the model never sees ignored files.
- A repository that follows the global config uses the global rules and the file's rules, without its own saved ones.
- The effective config (`GET /api/repos/:id/config`) names each rule's layer as `sources["rules.<id>"]`.

The editor checks patterns with the server's RE2 as they are typed, since a browser accepts lookarounds and backreferences that RE2 rejects. Dashboard rules are not visible in the repository, so the inline comment for a rule finding includes the rule's description and paths in a collapsed **📏 Rule** block.

### Static analysis findings

Sentryward does not run analyzers itself. With `review.tool_findings` on (the default), it reads the results that already exist on the forge for the reviewed commit and reports them next to the model's findings, marked with the analyzer's name:

- **GitHub:** annotations of the head commit's finished check runs, such as linters run in Actions or CodeQL. This needs the Checks (read) permission. Checks still running when the review starts are left out, with a warning.
- **GitLab:** the Code Quality (`gl-code-quality-report.json`) and SAST (`gl-sast-report.json`) reports of the head commit's pipeline. GitLab's API only serves files from a job's artifacts archive, so list the report under `artifacts:paths` as well as `artifacts:reports`. Otherwise it is skipped with a warning.

Only results on lines the change added are kept (or anywhere in a changed file, with `review.full_file`). They then pass the same category, `severity_floor`, dismissal and `max_findings` rules as model findings. Severity follows the analyzer's level: a GitHub failure is `major`, a warning `minor` and a notice `info`. A warning is filed under `maintainability`, which is not a default category, so linter warnings only appear when that category is enabled. When the model reported the same problem (same file and category, overlapping lines), the model's finding is kept. Tool findings never block unless `review.tool_findings_block` is on, because the analyzer's own check already passes or fails on the forge. If the results cannot be read (a missing permission, an unreachable report), the review continues with a warning.

## Privacy and data

Sentryward is self-hosted: review data stays in your PostgreSQL database, and source code only leaves the server for the model endpoints and forges you configure. This section lists what is kept and what is sent, and the controls that limit both.

### What is stored

- **Reviews** (`review_jobs`): the change's title, the resolved configuration, the full review result (findings with their file, lines, explanation and suggested fix, the walkthrough, model usage and cost), the record of what was published, and a small summary digest. Diffs and file contents are not stored, only what the model said about them.
- **Findings** (`findings`): one row per finding per change, with its title, file and line, severity, model, the change's title and author, and its state, including ignore reasons and notes.
- **Posted comments** (`posted_findings`): which inline comments were posted where, so a later run does not repost them.
- **Thread replies** (`thread_replies`): replies and `/sentryward` commands left on Sentryward's inline threads, including the commenter's text.
- **Credentials**: forge tokens, GitHub App installations, LLM API keys and notification URLs, encrypted with `ENCRYPTION_KEY` (AES-256-GCM). Only the last four characters of a key are ever shown.
- **Model capabilities and prices** per workspace, users, memberships, invites and API tokens (only hashes of invite, reset and API tokens are kept).
- **The audit log** of outbound model requests (see [Audit log](#audit-log)).

### What leaves the server

- **To model providers**, for each review: the diff of the change, surrounding file context (for agentic reviews, also the files and code-search results the model asks for), the review instructions and the repository's review rules, linked and related issue text for the walkthrough, and dismissed findings used to steer the review. Thread answers send the finding, the code around it and the reply text. Capability probes and connection tests send a fixed one-line prompt. Model list requests (`/models`) send only the key.
- **To forges**: API reads of the change, files, issues and analyzer results, and the comments, statuses, labels and description updates Sentryward publishes.
- **Elsewhere**: only the notification targets you configure (webhooks, Slack, email), which receive the review summary.

### Retention

Review data is kept forever unless a retention period is set. An instance admin sets one under **Administration > Instance settings**; when it is empty, `REVIEW_RETENTION_DAYS` from the environment applies, so existing deployments keep their behaviour. A workspace admin can set a shorter period for their workspace on the **Privacy** page; the shorter of the two applies. Once an hour the worker:

- prunes reviews older than the period as [described above](#how-it-works) (deletes runs that reviewed nothing, clears the stored result of older ones);
- purges changes that have had no activity of any kind (reviews, findings seen, ignored or resolved, replies) for longer than the period: their findings, posted-comment records and finished thread replies are deleted, and the result kept on their newest review is cleared. Review rows and summary digests stay, so usage, cost and the reviews list are unchanged. A change still under review is never purged, so findings do not lose their ignore state mid-review; if a purged change becomes active again it is reviewed afresh (the forge's own markers still stop inline comments from being posted twice), and benchmark and calibration figures no longer count its findings;
- deletes audit log entries older than the instance's **audit log retention** (empty keeps them forever). Only instance admins set this, so a workspace cannot erase its own trail.

### Provider and host restrictions

Instance admins (Instance settings) and workspace admins (Privacy page) can limit where model requests go:

- **Allowed providers**: the providers models may be named with (`anthropic`, `openai`, `google`, `ollama`). None selected allows all.
- **Allowed hosts**: where requests may be sent, such as `ollama.internal:11434` or `*.example.com` (any host below `example.com`, not the domain itself). A host without a port matches any port. Empty allows all. A model reached through an official API counts as that API's host (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`).
- **Local only**: only endpoints whose host is `localhost` or resolves entirely to private or loopback addresses (for example a self-hosted Ollama, a Docker service name or `host.docker.internal`) may be called. Every official provider API is refused, including server-wide keys from the environment.

A workspace can only narrow the instance: a model must pass both layers' lists, and local-only applies if either turns it on. Saving a workspace value the instance does not allow is refused. The policy is checked against every model a review may call, including fallbacks and models named in a repository's `.sentryward.yaml`, before anything is posted: a refused review, walkthrough or verify model fails the review with a message starting `Blocked by privacy policy:` that names the rule and the layer, and a refused fallback is skipped with a warning. Thread answers on a refused model post a short notice instead, without naming hosts. Saving, testing or listing models for an LLM connection the policy refuses is rejected before any request is made, and such a connection shows as **Blocked by policy**. The repository file cannot change these settings.

The local-only check resolves the host when the review starts. It protects against misconfiguration, not against an attacker who controls DNS (rebinding between the check and the request); for a hard guarantee, also block outbound traffic from the `worker` and `server` containers at the network level.

### Audit log

Every request sent to a model is recorded: time, workspace, repository and change, purpose (review, walkthrough, verify, capability probe, thread reply, connection test), provider, host, model, input/cached/output/reasoning tokens, latency and outcome. A failed request records only a short error kind (such as `http_429` or `unusable_reply`), never the error text, and prompts, code and replies are never recorded. Entries keep the workspace and repository names after those are deleted, until audit retention removes them.

Workspace admins see their workspace's log in the **Audit log** tab of the **Privacy** page; instance admins see every workspace's in the **Audit log** tab of **Administration > Instance settings**. Both can filter it and export it as CSV or JSON (up to 100,000 rows per export; an `X-Truncated: true` header marks a cut-off export). The endpoints, which API tokens can also read:

| Method | Path | Who |
| --- | --- | --- |
| `GET`/`PUT` | `/api/privacy` | Read: any member. Write: workspace admin |
| `GET` | `/api/privacy/audit-log`, `/api/privacy/audit-log/export?format=csv\|json` | Workspace admin |
| `GET`/`PUT` | `/api/admin/settings` | Instance admin |
| `GET` | `/api/admin/audit-log`, `/api/admin/audit-log/export?format=csv\|json` | Instance admin |

The audit log endpoints accept `provider`, `purpose`, `outcome`, `q` (searches model, host, repository and workspace), `from` and `to`, plus `page` and `limit` for the list and `workspaceId` for the instance-wide log.

## API

### API tokens

Scripts and CI authenticate with a personal API token instead
of the browser cookie. Create one under **Settings > API tokens**, with a name
and an expiry (7, 30, 90 or 365 days, or none). The value starts with `swt_`
and is shown only once, because only its hash is stored. Send it as a bearer
token; it acts as the user who created it, and the workspace header works as
it does for the dashboard:

```sh
curl -X POST https://sentryward.example.com/api/reviews \
  -H "Authorization: Bearer $SENTRYWARD_TOKEN" \
  -H "x-sentryward-workspace: <workspace id>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/acme/api/pull/42"}'

curl https://sentryward.example.com/api/reviews/<review id>/markdown \
  -H "Authorization: Bearer $SENTRYWARD_TOKEN"
```

A token can make any `GET` request its user can, plus `POST /api/reviews` and
`POST /api/reviews/:id/rerun`. Every other write gets `403`, and tokens cannot
manage tokens, so a leaked one can't change the account or create more tokens.
The GitHub install and GitLab OAuth flows under `/api/connections` are `GET`
but add connections, so they need a signed-in session too.
A revoked, expired or unknown token gets `401`. If the `Authorization` header
is present, the cookie is ignored. Token requests count against the same
per-user rate limit as the user's dashboard requests. Tokens survive password
changes and resets, including resets an admin issues; revoke them one by one in
Settings. Deleting the account deletes its tokens.

<details>
<summary>Endpoint reference</summary>

Endpoints that act on workspace data (connections, repositories, reviews,
findings, global config, LLM keys and notifications) read the workspace id from the
`x-sentryward-workspace` header. Without it they use the caller's personal workspace,
so scripts written before workspaces keep working. Routes under
`/api/workspaces/:id` name the workspace in the path instead.

| Method | Path                 | Description |
| ------ | -------------------- | ----------- |
| POST   | `/api/auth/register` | `{ name, email, password, confirmPassword, inviteToken? }`, sets the auth cookie; `inviteToken` is required when `REGISTRATION_MODE=invite` |
| GET    | `/api/auth/registration` | `{ mode, firstUser, mailConfigured }`, so the register page can say whether it is usable and the forgot password page whether a reset can be emailed |
| GET    | `/api/auth/invites/:token` | The invite's email, inviter and expiry, or 404 when invalid, used or expired |
| POST   | `/api/auth/invites/:token/accept` | Signed in: joins the team the invite is for and returns that workspace |
| POST   | `/api/auth/login`    | `{ email, password }`, sets the auth cookie |
| POST   | `/api/auth/password-reset` | `{ email }`; emails a reset link when the account exists and mail is configured. Always `202 {}` |
| GET    | `/api/auth/password-reset/:token` | `{ email }` for a valid link, or 404 when invalid, used or expired |
| POST   | `/api/auth/password-reset/:token` | `{ password, confirmPassword }`; sets the password, ends other sessions, sets the auth cookie and returns the session |
| POST   | `/api/auth/logout`   | Clears the auth cookie |
| GET    | `/api/auth/me`       | Current user, or 401 |
| GET    | `/api/connections`   | The workspace's forge connections, which browser connect flows are configured, and the GitLab OAuth host |
| POST   | `/api/connections/gitlab` | `{ host?, token }`, validates the token against GitLab and stores it encrypted |
| GET    | `/api/connections/github/install?workspace=` | Session only: redirects to the GitHub App's install page; the installation is added to that workspace |
| GET    | `/api/connections/github/callback` | Session only: GitHub's return URL after installing the app |
| GET    | `/api/connections/gitlab/oauth/start?workspace=` | Session only: redirects to GitLab's OAuth authorize page with a single-use state (PKCE) |
| GET    | `/api/connections/gitlab/oauth/callback` | Session only: GitLab's OAuth redirect URI; validates the state, exchanges the code and stores the connection |
| DELETE | `/api/connections/:id` | Removes a connection and its repositories |
| GET    | `/api/repos?connectionId=` | Repositories the connection can see, with their enabled flag |
| POST   | `/api/repos`         | `{ connectionId, externalId }`, enables a repository for review |
| PATCH  | `/api/repos/:id`     | `{ enabled?, settings?, followGlobal? }`; `settings` replaces the saved review overrides, `followGlobal` makes the repository ignore them and use only the global config |
| GET    | `/api/repos/:id/config` | The effective review config for the default branch, where each value came from, and any repository-file warnings |
| POST   | `/api/reviews`       | `{ url }` of a pull or merge request on an enabled repository; queues a review of its current head |
| GET    | `/api/reviews?repoId=&status=&page=&limit=` | The workspace's reviews, newest first, with a summary but not the full result; returns `{ reviews, total, page, limit }` (`limit` 1-100, default 20) |
| GET    | `/api/reviews/stats?repoId=&days=` | Runs, verdicts, review time and token totals over the last `days` (default 7), with `cost: { usd }`: the summed costs reviews recorded when they ran. Reviews from before costs were recorded add nothing |
| GET    | `/api/reviews/:id`   | One review with its full result; each model call carries the `cost` it recorded and `usageTotals.costUsd` sums them |
| GET    | `/api/usage?period=&repoId=` | Model usage of the workspace's reviews over `24h`, `7d` (default), `30d`, `90d` or `all`: totals with input, cached and output tokens and the cost, a UTC time series (hourly for `24h`, monthly for a long `all`), and breakdowns by model (input, cached and output cost each), provider and repository |
| GET    | `/api/benchmarks?period=&repoId=` | Model benchmarks over `24h`, `7d` (default), `30d`, `90d` or `all`: `totals`, `byModel` (reviews, tokens, `cost: { usd, partial, perReview }` with `usd` null when no call had a price, `meanLatencyMs`, `findings`), `byRepository` (adds `medianDurationMs` and `duplicates: { count, rate }`), and `byLanguage` / `byCategory` rows `{ key, findings, models, best }`. `findings` is `{ found, confirmed, falsePositives, confirmedRate, falsePositiveRate }` over findings first seen in the period |
| GET    | `/api/usage/recent?period=&repoId=&page=&limit=` | `{ reviews, total, page }`: one page (`limit` 10 by default, 100 at most) of the period's reviews that called a model, newest first, with their models, tokens and cost; a page past the end returns the last one |
| GET    | `/api/reviews/:id/markdown` | The review as the markdown document that is posted to the forge |
| POST   | `/api/reviews/:id/rerun` | Queues a fresh review of the PR's latest head |
| POST   | `/api/reviews/:id/cancel` | Cancels a queued or running review; a running one stops within one check interval (about 15s) and posts nothing more. `409` once it has finished |
| GET    | `/api/findings/stats?repoId=&days=` | Open findings by severity, resolution rate, median time to resolve (invalidated findings count as neither) and the false-positive rate over the last `days` (1-365, default 30); `falsePositivesBy` breaks that rate down by `category` (unknown stored categories as `other`), `severity` and `model` (the model whose review pass raised each finding, `null` for tool and rule findings and rows with no recorded model), each row `{ key, found, falsePositives, rate }` |
| GET    | `/api/findings/calibration?repoId=&days=&groupBy=` | How the confidence models self-report has matched outcomes over the last `days`: findings bucketed by reported confidence in tenths, each bucket `{ min, max, found, confirmed, falsePositives, decided, confirmedRate, falsePositiveRate }` where confirmed means fixed, false positive means dismissed as one, and the rates are over `decided` (the two together). `groupBy` is `none` (default, one group), `model` or `category`. Tool and rule findings carry no self-reported confidence and are left out. The response sets `selfReported: true`: confidence is never a calibrated probability by itself |
| POST   | `/api/webhooks/github` | GitHub App webhook (signed with `GITHUB_WEBHOOK_SECRET`) |
| POST   | `/api/webhooks/gitlab/:repoId` | GitLab project hook Sentryward registers per repository (token checked per repository) |
| GET    | `/api/config/schema` | Defaults, profiles, severities and categories for the settings UI |
| GET    | `/api/config/global` | The workspace's global review config, and what it resolves to with each value's source |
| PUT    | `/api/config/global` | Workspace admins: `{ settings }`, replaces the global review config; `{}` resets it |
| POST   | `/api/config/rules/check` | `{ patterns }` (up to 50, 300 characters each): `{ errors }`, one per pattern in order, `null` when RE2 compiles it, otherwise the message a save would give |
| GET    | `/api/settings/api-keys` | Every LLM provider, with whether the workspace stored a credential, its key's last four characters, its custom host, whether the server has a key of its own and whether the privacy policy blocks the provider or host (`blocked`) |
| PUT    | `/api/settings/api-keys/:provider` | Workspace admins: `{ apiKey?, baseUrl? }`, verifies the credential with the provider and stores the key encrypted |
| DELETE | `/api/settings/api-keys/:provider` | Workspace admins: removes the stored credential |
| GET    | `/api/settings/api-keys/:provider/status` | `{ status }`: `active`, `revoked` when the provider rejects the key, or `unreachable` |
| GET    | `/api/settings/api-keys/:provider/models` | The model ids the connection lists, prefixed with its provider; 400 when the host rejects the key or is down |
| POST   | `/api/settings/api-keys/:provider/test` | `{ model }`, runs one minimal generation with the stored credential; returns `{ result }` with latency and token usage, or `ok: false` with a `reason` (`revoked`, `model`, `unreachable`, `output`) and message. A passing test also probes the model and adds `capabilities: { thinking, tools, detail }`, which it stores. 400 when an official API is given another provider's model; 409 when the stored key can't be decrypted |
| GET    | `/api/settings/model-prices` | `{ prices, models }`: the workspace's own model prices (`{ id, model, price, updatedAt }`, USD per million tokens) and the models its reviews called in the last 90 days with their built-in price and the price reviews get now, workspace prices included (`builtIn`, `price`; `null` when unknown) |
| PUT    | `/api/settings/model-prices` | Workspace admins: `{ model, input, output, cached?, cacheWrite?, reasoning? }`, saves (or replaces) the price for `model`; applies to reviews from then on |
| DELETE | `/api/settings/model-prices/:id` | Workspace admins: removes a price |
| GET    | `/api/settings/api-keys/:provider/capabilities` | `{ capabilities }`: per model reached through the connection, `{ model, endpoint, thinking, tools, source, detail, checkedAt }`, where `thinking` is `options`, `model`, `none` or `null` (unknown), `tools` is a boolean or `null`, and `source` is `probe` or `runtime`. Saving or removing the connection clears them |
| GET    | `/api/notifications` | `{ targets, mailConfigured }`: the workspace's notification targets with their events, whether each is `active`, a URL's host only and email recipients' user ids |
| POST   | `/api/notifications` | Workspace admins: `{ kind: "webhook" \| "slack", name, events, url }` or `{ kind: "email", name, events, recipientIds }`; returns `{ target, secret? }`, a webhook's signing secret shown only here |
| PATCH  | `/api/notifications/:id` | Workspace admins: `{ name?, events?, recipientIds?, active? }`; `active: false` pauses deliveries |
| POST   | `/api/notifications/:id/test` | Workspace admins: sends a sample delivery; returns `{ result }`, `{ ok: true }` or `{ ok: false, error }` |
| DELETE | `/api/notifications/:id` | Workspace admins: removes a target |
| PUT    | `/api/settings/avatar` | Raw PNG, JPEG or WebP body (512 KB at most; the dashboard uploads a 256px JPEG); sets the caller's profile picture |
| GET    | `/api/settings/tokens` | Session only: the caller's API tokens with name, creation, last use and expiry; never the values |
| POST   | `/api/settings/tokens` | Session only: `{ name, expiresInDays }` (1-365, or `null` for no expiry); returns `{ token, value }`, the value shown only here |
| DELETE | `/api/settings/tokens/:id` | Session only: revokes one of the caller's tokens |
| DELETE | `/api/settings/avatar` | Removes the caller's profile picture, so their initials show again |
| GET    | `/api/users/:id/avatar` | A user's profile picture, for any signed-in user; 404 when they have none |
| GET    | `/api/admin/users`   | Admin only: every user with their role |
| PATCH  | `/api/admin/users/:id` | Admin only: `{ role: "admin" \| "member" }`; refuses to remove the last admin |
| DELETE | `/api/admin/users/:id` | Admin only: deletes another user and everything they own |
| POST   | `/api/admin/users/:id/password-reset` | Admin only: returns `{ link, expiresAt }`, a single-use reset link shown only here |
| GET    | `/api/admin/invites` | Admin only: pending invites |
| POST   | `/api/admin/invites` | Admin only: `{ email? }`; returns `{ invite, link, emailed }`, the link is shown only here |
| POST   | `/api/admin/invites/:id/resend` | Admin only: emails a new link for an email invite and renews its expiry; needs SMTP |
| DELETE | `/api/admin/invites/:id` | Admin only: revokes a pending invite |
| GET    | `/api/workspaces`    | The caller's workspaces with their role in each |
| POST   | `/api/workspaces`    | `{ name }`, creates a team workspace owned by the caller |
| PATCH  | `/api/workspaces/:id` | Owners: `{ name }`, renames a team |
| DELETE | `/api/workspaces/:id` | Owners: deletes a team and everything in it, removing Sentryward's forge hooks first |
| GET    | `/api/workspaces/:id/members` | Members with their role and join date |
| POST   | `/api/workspaces/:id/members` | Team admins: `{ email, role? }`, adds an existing account as `admin` or `member` |
| GET    | `/api/workspaces/:id/member-candidates` | Team admins: accounts not yet in the team, for the add-member picker |
| PATCH  | `/api/workspaces/:id/members/:userId` | Team admins: `{ role }`; only owners grant or revoke `owner`, and the last owner cannot be demoted |
| DELETE | `/api/workspaces/:id/members/:userId` | Team admins remove a member; any member may remove themselves to leave |
| GET    | `/api/workspaces/:id/invites` | Team admins: pending team invites |
| POST   | `/api/workspaces/:id/invites` | Team admins: `{ email?, role? }`; returns `{ invite, link, emailed }` like an instance invite |
| POST   | `/api/workspaces/:id/invites/:inviteId/resend` | Team admins: emails a new link for an email invite and renews its expiry |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | Team admins: revokes a pending team invite |

Register, login, the registration mode, invite lookups and password resets are rate limited (20 requests per 15 minutes per IP).

</details>

## Development

<details>
<summary>Stack</summary>

| Layer    | Tech |
| -------- | ---- |
| Client   | Vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, React Router, TanStack Query, react-hook-form + zod |
| API      | Express 5, TypeScript (run with tsx), Prisma 7 (`@prisma/adapter-pg`), zod, argon2id, JWT in an httpOnly cookie |
| Database | PostgreSQL 17 |

**Why PostgreSQL over MySQL**

- Real `UUID`, `TIMESTAMPTZ` and `CITEXT` types (emails are case-insensitive at the database level).
- `JSONB`, arrays, full-text search and row-level security for future cloud features.
- Transactional DDL, so a failed migration rolls back cleanly.

</details>

### Tests

```sh
docker compose exec server npm test   # API tests against the sentryward_test database
docker compose exec client npm test   # React component and routing tests
```

GitHub Actions also runs type checks, client lint, and the client production
build inside Docker. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete checks.

### Review quality evals

The tests use a fake model, so they say nothing about how good the reviews are.
`server/evals/` holds a corpus of small changes with the findings a good review
should report, and a script that reviews each one with a real model and scores
the result. Use it to tell whether a change to prompts, chunking, context or
validation helps. It calls the provider's API and costs money, so it is not
part of `npm test` or CI.

```sh
# the key must be in the container's environment, e.g. ANTHROPIC_API_KEY in .env for the worker
docker compose exec worker npm run eval -- --model anthropic/claude-sonnet-5-5
docker compose exec worker npm run eval -- --model anthropic/claude-sonnet-5-5 --case ts-sql-injection,py-ssrf
```

| Option | Default | |
| --- | --- | --- |
| `--model` | the default review model | `provider/model`, as in `.sentryward.yaml` |
| `--case` | every case | comma-separated case ids (directory names) |
| `--concurrency` | `2` | cases reviewed at once |
| `--tolerance` | `2` | lines a finding may sit outside an expected range and still match |
| `--strict-category` | off | also require the finding's category to be one the case accepts |
| `--price` | built-in table | `<input>,<output>` USD per million tokens, for models the table does not list |
| `--base-url` | none | send the model's calls to this endpoint (a proxy or Ollama) |
| `--thinking` | the case's setting (`off`) | `off`, `low`, `medium` or `high` |
| `--context` | the case's setting (`static`) | `static` or `agentic` |
| `--compare` | off | review every case twice, with thinking off and static context, then with `--thinking` (default `medium`) and `--context`, and print recall, precision and cost side by side |
| `--out` | `server/evals/reports/<time>-<model>.json` | where to write the report |

Each case runs through `runReview` with the default configuration, so it
measures what production would report. A finding matches an expected finding
when it is in the same file and its lines overlap the expected range (within
the tolerance); each expectation is credited once. The script prints a table and
writes a JSON report with per-case findings, misses, false positives (and which
of them hit a known trap), token use and cost, plus precision, recall and F1
over the whole corpus. A review that fails outright is reported as errored and
left out of the rates. Set `EVAL_GIT_SHA` to record the commit, since the
container has no git.

**Adding a case.** Create `server/evals/cases/<id>/` with:

- `before/` and `after/`: the files the change touches, before and after. `after/`
  also serves as the head revision for review context, so include files the
  reviewer would need to read.
- `diff.patch`: generate it on the host with `sh server/evals/make-patch.sh server/evals/cases/<id>`.
- `case.yaml`:

```yaml
title: Add product search          # the PR/MR title
description: Adds GET /products/search.
language: typescript
expected:                          # leave out for a change with nothing to report
  - file: src/products/repository.ts
    lines: [17, 18]                # new-file line range
    category: security             # or a list of acceptable categories
    description: search term interpolated into SQL
traps:                             # code that looks wrong but is not
  - file: src/products/routes.ts
    lines: [6, 6]
    note: /search is registered before /:id
config: {}                         # optional camelCase config override, e.g. { review: { categories: [style] } }
```

`npm test` checks that every case loads and that each expected and trap range
starts on an added line (a finding on an unchanged line is moved to the
nearest added one), without calling a model. CodeQL scans the fixtures too,
so a deliberately vulnerable case can raise an alert on its PR; dismiss it as
"used in tests".

### Database changes

```sh
# edit server/prisma/schema.prisma, then:
docker compose exec server npx prisma migrate dev --name <change>
```

### Project layout

```
client/   React SPA (shadcn components live in src/components/ui)
server/   Express API (src/routes, src/controllers, prisma/schema.prisma) and the review worker (src/worker)
docker/   Postgres init script (creates the test database)
```

## Contributing and license

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md), and look for
[good first issues](https://github.com/rdlugs/sentryward/labels/good%20first%20issue).
Questions and ideas go to [Discussions](https://github.com/rdlugs/sentryward/discussions).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
which also covers deployment boundaries and how credentials are stored.
Release notes are in the [changelog](CHANGELOG.md).

Licensed under [MIT](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md).
