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

Sentryward is an AI code reviewer for GitHub pull requests and GitLab merge
requests. Connect repositories, choose a model provider or Ollama, and run
manual or automatic reviews with inline findings, walkthroughs, and commit
statuses. The dashboard tracks reviews and findings across runs.

> [!WARNING]
> Sentryward is pre-1.0: minor releases may include breaking changes. AI findings
> need human verification and can miss problems or report false positives.
> `docker-compose.yml` is for development; to host an instance, see [Deploying](#deploying).

## Contents

- **Start here:** [Highlights](#highlights) · [Quick start](#quick-start) · [How it works](#how-it-works)
- **[Getting started](#getting-started):**
  [runtime environment](#docker-runtime-environment) ·
  [users and invites](#users-and-invites) ·
  [sign in with GitHub or GitLab](#sign-in-with-github-or-gitlab) ·
  [password resets](#password-resets) ·
  [workspaces and teams](#workspaces-and-teams) ·
  [first review](#run-your-first-review) ·
  [troubleshooting](#troubleshooting)
- **[Deploying](#deploying):**
  [environment variables](#environment-variables) ·
  [worker tuning](#worker-tuning)
- **[Forge connections](#forge-connections):** [GitHub](#github) · [GitLab](#gitlab)
- **Reviews on the forge:**
  [publishing](#publishing-to-the-forge) ·
  [replying to findings](#replying-to-findings) ·
  [automatic reviews](#automatic-reviews) ·
  [notifications](#notifications)
- **[Review configuration](#review-configuration):**
  [LLM connections](#llm-connections-and-custom-endpoints) ·
  [model prices and benchmarks](#model-prices-and-benchmarks) ·
  [model capabilities](#model-capabilities) ·
  [thinking and agentic context](#thinking-and-agentic-context) ·
  [Ollama](#ollama) ·
  [`.sentryward.yaml`](#sentrywardyaml-reference) ·
  [review rules](#review-rules) ·
  [static analysis findings](#static-analysis-findings)
- **[Privacy and data](#privacy-and-data):**
  [what is stored](#what-is-stored) ·
  [what leaves the server](#what-leaves-the-server) ·
  [retention](#retention) ·
  [provider restrictions](#provider-and-host-restrictions) ·
  [audit log](#audit-log)
- **[API](#api):** [API tokens](#api-tokens) · [endpoint reference](#endpoint-reference)
- **[Development](#development):**
  [tests](#tests) ·
  [review quality evals](#review-quality-evals) ·
  [database changes](#database-changes) ·
  [project layout](#project-layout)
- [Contributing and license](#contributing-and-license)

## Highlights

- **Self-hosted, bring your own model:** Anthropic, OpenAI, Google, a compatible
  proxy on a [custom host](#llm-connections-and-custom-endpoints), or a local
  [Ollama](#ollama) model.
- **GitHub and GitLab:** a GitHub App, plus GitLab.com or self-hosted GitLab.
- **Reviews where you work:** inline findings with suggestions, one summary
  comment, and optionally a `sentryward/review` commit status.
- **Manual or automatic:** submit a PR/MR URL, review on webhooks, or comment
  `/sentryward review`.
- **Per-repository config:** dashboard settings, overridable by a
  [`.sentryward.yaml`](#review-configuration) in the repository.
- **Findings across runs:** a later run never posts the same finding twice.
  Ignore findings as false positives, intentional, or fix later, and track the
  false-positive rate on the dashboard, broken down by category, severity and
  model, with a pointer to the setting that would quiet the noisiest ones.
- **Teams:** share connections, repositories, reviews and model keys in team
  workspaces, with owner, admin and member roles and one-time invite links,
  managed from **Team settings** in the workspace switcher.

## Quick start

Requires Docker with Compose.

```sh
git clone https://github.com/rdlugs/sentryward.git && cd sentryward
cp .env.example .env
# set JWT_SECRET and ENCRYPTION_KEY in .env, each with: openssl rand -hex 32
# keep NODE_ENV=development for the local HTTP setup
docker compose up --build
```

Open http://localhost:5173, register, then follow
[Run your first review](#run-your-first-review). Ports, health checks and
accounts are covered in [Getting started](#getting-started).

## How it works

```mermaid
flowchart LR
    T["Trigger:<br/>dashboard URL, webhook,<br/>or /sentryward review"] --> Q[("review_jobs queue")]
    Q --> W["Worker claims the job"]
    W --> F["Fetch the PR/MR<br/>from the forge"]
    F --> C["Resolve the review config"]
    C --> P["Review passes<br/>(+ optional walkthrough)"]
    P --> V["Validate findings,<br/>verify blocking ones"]
    V --> O["Publish: inline comments,<br/>summary comment, commit status"]
    O --> S[("Store the result")]
```

1. A review is queued by a URL submitted in the dashboard, a forge webhook, or a
   `/sentryward review` comment.
2. The `worker` container claims the job from the `review_jobs` table and
   fetches the PR/MR from the forge.
3. It resolves the [review configuration](#review-configuration): trigger
   overrides, then `.sentryward.yaml` at the base revision, repository settings,
   the global config, the profile, and built-in defaults.
4. It sends the diff to the configured model in one or more passes, plus an
   optional walkthrough.
5. It validates the findings and re-checks blocking ones with a second model
   call (`review.verify`). `llm.walkthrough_model` and `llm.verify_model` can
   point those two calls at a different model than the review passes.
6. It [publishes](#publishing-to-the-forge) to the forge and stores the result
   on the job.

Model keys come from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
`GOOGLE_GENERATIVE_AI_API_KEY`, unless the repository's workspace has stored its
own. Several workers can run side by side; see [Worker tuning](#worker-tuning).
How long reviews keep their data is covered in [Retention](#retention).

## Getting started

Follow [Quick start](#quick-start) first. The initial `docker compose up --build`
builds the client and server dependency images. For subsequent starts, use
`docker compose up`. Source changes are bind-mounted into the containers and
picked up by the development watchers without rebuilding. Rebuild the images
when either `package.json` or `package-lock.json` changes.

| Service | Default URL | Port variable |
| --- | --- | --- |
| Web client | http://localhost:5173 | `CLIENT_HOST_PORT` |
| API | http://localhost:4000/api (the client proxies `/api` to it) | `API_HOST_PORT` |
| Postgres | localhost:5433 | `DB_HOST_PORT` |

If you change `CLIENT_HOST_PORT`, update `CLIENT_ORIGIN` to match. Migrations
are applied automatically when the `server` container starts.

Check startup without opening a browser:

```sh
curl --fail http://localhost:4000/api/health
```

Use your configured `API_HOST_PORT` if it differs. A ready API returns
`{"status":"ok"}`. The database lives in a persistent Docker volume; rebuilding
images does not delete it.

### Docker runtime environment

Set `NODE_ENV` in `.env`; the API and worker both use it, defaulting to
`development` when omitted or empty. Recreate affected services after changing
it:

```sh
docker compose up -d server worker
```

| Value | API and worker behavior |
| ----- | ----------------------- |
| `development` | Local HTTP authentication cookies; local/private forge hosts are allowed. |
| `production` | Secure authentication cookies, and existing HTTPS/public-address checks for self-hosted forge hosts. Use an HTTPS client origin. |

`test` is reserved for automated tests; the server test script sets it
explicitly. Other values fail startup validation.

> [!WARNING]
> `production` does not switch Docker commands, disable watchers, build/serve
> the frontend, or provide HTTPS. The client still runs Vite's development
> server, so do not expose this Compose setup publicly; use the production image
> instead (see [Deploying](#deploying)).

### Users and invites

The first account registered on an instance becomes its **admin**, and so does
the oldest account on an install that predates roles. Admins see **Users** in
the sidebar, where they can promote or demote admins, remove users and create
invite links. An instance always keeps at least one admin. A user's
personal-workspace connections, repositories and reviews stay private to them;
data in a team workspace is shared with that team's members. Being an admin
does not by itself grant access to either.

`REGISTRATION_MODE` in `.env` controls who can create an account:

| Value | Who can register |
| ----- | ---------------- |
| `open` (default) | Anyone who can reach the client |
| `invite` | People with an instance invite, or a team invite whose original creator is currently an instance admin. An eligible team invite also places the new account in that team |
| `closed` | No new accounts; admins can still create invites, but they cannot register anyone until the mode allows it. Existing signed-in users can still accept a team invite to join a workspace |

- The login page only links to sign-up when registration is `open` or the
  instance has no accounts yet; invitees register from their invite link.
- In invite mode, team invites from other users only let existing accounts join
  the team. A team invite stops permitting registration if its original creator
  is demoted from instance admin or deleted. Resending preserves the original
  creator and does not grant registration authority.
- An invite link works once and expires after 7 days. Adding an email limits
  the link to that address.
- When `SMTP_URL` (for example `smtp://user:pass@smtp.example.com:587`) and
  `MAIL_FROM` are set, the link is also emailed; otherwise copy it from the
  dialog, which shows it only once. Resending an emailed invite sends a new link
  and renews its expiry; the old link stops working.

### Sign in with GitHub or GitLab

People can sign up and log in with a GitHub or GitLab account (gitlab.com or a
self-managed instance) as well as with email and password. Each provider shows
on the login and register pages once its client id and secret are set.

These are **separate OAuth apps** from the [forge connections](#forge-connections):
they ask only for identity (`read:user user:email` on GitHub, `read_user` on
GitLab), never connect a forge and never install the GitHub App. Keeping them
apart means a login never holds repository access.

- **GitHub:** create an OAuth App (Settings > Developer settings > OAuth Apps)
  with the callback URL `<CLIENT_ORIGIN>/api/auth/oauth/github/callback`, then
  set `GITHUB_LOGIN_CLIENT_ID` and `GITHUB_LOGIN_CLIENT_SECRET`. For GitHub
  Enterprise Server, also set `GITHUB_LOGIN_HOST`.
- **GitLab:** create an application (User settings > Applications, or Admin >
  Applications on a self-managed instance) with the redirect URI
  `<CLIENT_ORIGIN>/api/auth/oauth/gitlab/callback`, scope `read_user` and
  Confidential on, then set `GITLAB_LOGIN_CLIENT_ID` and
  `GITLAB_LOGIN_CLIENT_SECRET`, plus `GITLAB_LOGIN_HOST` for a self-managed host.

How accounts are matched:

- The provider's **verified** primary email is used; an account without one is
  refused.
- A first sign-in creates an account with no password, through the same rules
  as a password sign-up: `REGISTRATION_MODE`, invites (an invite link carries
  through the provider round trip) and the first account becoming admin.
- An existing account is **never** linked by matching email, since a provider
  address could be unverified elsewhere or reassigned. Its owner signs in their
  usual way and links the provider under Settings > Sign-in methods, where
  linked accounts can also be removed. The last remaining way to sign in cannot
  be removed.
- An account without a password can set one in Settings, and confirms deleting
  itself by typing its email.

`PASSWORD_LOGIN=disabled` turns email and password sign-in, sign-up and resets
off, leaving only the providers. The server refuses to start that way unless at
least one provider is configured. Accounts that only have a password cannot
sign in while it is disabled, so link a provider to admin accounts first.

### Password resets

"Forgot password?" on the login page emails a reset link when `SMTP_URL` is
set.

- The request always gets the same answer, so it does not reveal which emails
  have accounts.
- The link works once and expires after 1 hour. Requesting another one replaces
  it, but at most one email is sent to an account every 2 minutes.
- Without mail, the page tells the user to ask an admin, who can create a link
  from the user's actions on the Admin page (it works once, expires after 24
  hours and is shown only once). Admins can do this whether or not mail is set
  up. An admin's link replaces any earlier one, and a later emailed request
  leaves it working.
- Whether mail is configured is public, through `GET /api/auth/registration`.

Setting a new password from a link signs the user in and ends every other
session. Changing the password in Settings does the same, keeping only the
current browser signed in.

### Workspaces and teams

Every account has a private **personal workspace**. Anyone can also create a
**team workspace** from the switcher in the sidebar; its forge connections,
repositories, reviews, findings, global review config and LLM keys belong to
the team rather than to one person. The dashboard remembers the workspace you
last used.

| Role | Can |
| ---- | --- |
| `member` | View the team's data, request, rerun and cancel reviews, triage findings, leave the team |
| `admin` | Everything a member can, plus manage connections, repositories, review config and LLM keys, add and remove members, and invite people |
| `owner` | Everything an admin can, plus grant or revoke ownership, rename and delete the team |

- A team always keeps at least one owner, so the last owner has to promote
  someone else before leaving or deleting their account.
- The **Team** page (`/workspace`) lists members, pending invites and settings.
- By default, adding a member requires an exact email address and creates an
  email-bound invitation. Access begins only after the recipient accepts. The
  invitation can be emailed when SMTP is configured, or its link can be copied
  and shared. Account names and emails are not listed.
- Instance admins can enable **Allow direct member additions** under
  **Administration > Instance settings > Policy** to expose the account picker
  to team admins and let them add existing accounts immediately. This setting
  defaults to off on both new and upgraded installations; existing memberships
  are unaffected.
- Admins can also share a team invite link. In invite mode, only team invites
  whose original creator is currently an instance admin can register new
  accounts; other team invites require an existing account.

### Run your first review

1. Open the client URL and register an account. The first account is the admin.
2. In **LLM Connections**, add and verify a model provider key, or configure
   [Ollama](#ollama). External providers may charge for model usage.
3. In **Review settings**, select that connection and a model available to it.
4. In **Repositories**, connect GitLab or install your configured GitHub App
   using the [forge setup](#forge-connections), then add a repository for
   review.
5. In **Reviews**, submit the URL of an open PR/MR on that repository. The
   worker processes it and the detail page shows results or the reason it
   failed.

> [!IMPORTANT]
> Default publishing can post comments and statuses and update the description.
> For an initial evaluation, use a test repository or disable publishing in
> Review settings before running the review.

Manual reviews do not require an internet-reachable webhook URL; automatic
reviews do.

<details>
<summary>Sample summary comment (excerpt)</summary>

**Summary**

Adds b and c.

🏷️ Labels: `feature` · ⏱️ Review effort: 1/5 · 💥 Blast radius: small

| File | Summary |
| --- | --- |
| `src/app.ts` | Two new constants. |

⛔ **Blocked**: 1 finding at or above critical.

- 🔴 **critical** `src/app.ts:11`: SQL built from @​input

4 findings (1 critical, 1 major, 2 minor): 2 actionable, 2 in the sections below.

> 🔄 Since the last review: 1 new, 2 still open, 1 reopened, 1 fixed, 1 invalidated.

</details>

The excerpt comes from the
[synthetic review output fixture](server/tests/__snapshots__/review.md), which
shows the full rendered markdown. It exercises presentation and is not a real
review or evidence of model accuracy.

Next: [connect a forge](#forge-connections) for automatic reviews, or
[deploy an instance](#deploying).

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

The production setup is one image, `ghcr.io/rdlugs/sentryward`, that runs the
API, serves the built dashboard from the same origin, and runs the review worker
with a different command. `docker-compose.prod.yml` runs it with PostgreSQL. It
has no source mounts or dev dependencies, and does not publish the database
port. TLS is left to a reverse proxy you run in front of it.

```sh
cp .env.production.example .env.production
# fill in POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY and your public URL
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Images are published for `linux/amd64` and `linux/arm64` on each release tag.
`SENTRYWARD_VERSION` picks the tag (for example `0.4.0`). `latest` follows the
newest stable release only; pin a version for controlled upgrades. To build
from source instead, set `SENTRYWARD_VERSION` to a local name and run
`docker compose -f docker-compose.prod.yml --env-file .env.production build server`
before `up`.

- **Public URL:** set `CLIENT_ORIGIN` and `API_PUBLIC_URL` to the same
  `https://` URL. The GitHub App's setup URL becomes
  `<url>/api/connections/github/callback` and its webhook URL
  `<url>/api/webhooks/github`; a GitLab OAuth application's redirect URI becomes
  `<url>/api/connections/gitlab/oauth/callback`; GitLab webhooks use it
  automatically. Sign-in apps use `<url>/api/auth/oauth/github/callback` and
  `<url>/api/auth/oauth/gitlab/callback`.
- **Reverse proxy:** the API listens on `127.0.0.1:4000` on the host
  (`API_BIND`, `API_HOST_PORT`). `TRUST_PROXY` (default `1`) is the number of
  proxies in front, so rate limits see client addresses; set it to match your
  setup. A minimal Caddy config, which also obtains the certificate:

  ```
  sentryward.example.com {
      reverse_proxy 127.0.0.1:4000
  }
  ```

- **Registration:** the production example defaults `REGISTRATION_MODE` to
  `invite`. The first account still registers freely and becomes the admin, so
  create it before sharing the URL.
- **Upgrades:** back up the database, change `SENTRYWARD_VERSION`, then run
  `pull` and `up -d` with the same `-f` and `--env-file` flags. The server
  applies migrations before it reports healthy, and the worker starts after it.
  - The old worker waits up to `WORKER_SHUTDOWN_DRAIN_MS` (default 10 minutes)
    for its in-flight reviews, then puts any still running back in the queue
    without using one of their attempts and exits, so the new worker picks them
    up about half a minute later (once any forge call the old one had in flight
    has landed).
  - Compose waits up to `WORKER_STOP_GRACE_PERIOD` (default `15m`) before
    killing it; keep that above the drain time, or unfinished reviews wait for
    stale-lock recovery instead. `stop -t <seconds>` overrides the wait.
- **Backups:** the `pgdata` volume holds everything (for example
  `docker compose -f docker-compose.prod.yml exec db pg_dump -U sentryward sentryward`).
- **Model endpoints on the host** (such as Ollama): the production file does
  not add `host.docker.internal`. Add an `extra_hosts` entry to the worker and
  server if you need it.

> [!CAUTION]
> Back up `ENCRYPTION_KEY` separately and keep it stable: stored forge tokens
> and model keys cannot be decrypted without it. After a key change, API keys
> show as unreadable until they are re-entered, forge connections show as
> inactive until reconnected, and repository webhooks need the repository
> disabled and enabled again.

Read [SECURITY.md](SECURITY.md) before exposing an instance.

### Environment variables

Both `.env.example` (development) and `.env.production.example` (production)
document these. Variables marked required must be set or the server will not
start.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| **Core** | | | |
| `NODE_ENV` | no | `development` | `development` or `production`; see [Docker runtime environment](#docker-runtime-environment) |
| `JWT_SECRET` | yes | none | Signs session cookies; at least 32 characters (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | yes | none | Encrypts forge tokens, LLM keys and notification URLs at rest; exactly 64 hex characters (`openssl rand -hex 32`) |
| `REGISTRATION_MODE` | no | `open` (`invite` in the production example) | `open`, `invite` or `closed`; see [Users and invites](#users-and-invites) |
| `PASSWORD_LOGIN` | no | `enabled` | `disabled` leaves only sign-in providers; see [Sign in with GitHub or GitLab](#sign-in-with-github-or-gitlab) |
| **Database** | | | |
| `POSTGRES_USER` / `POSTGRES_DB` | no | `sentryward` | Database user and name |
| `POSTGRES_PASSWORD` | yes in production | `sentryward` in the dev example | Database password (`openssl rand -hex 24`) |
| **Ports and URLs** | | | |
| `CLIENT_ORIGIN` | no (yes in production) | `http://localhost:5173` | URL the dashboard is opened on |
| `API_PUBLIC_URL` | no (yes in production) | `http://localhost:4000` | Where forges reach the API, used for webhook URLs |
| `CLIENT_HOST_PORT` | no | `5173` | Development only: host port for the web client |
| `API_HOST_PORT` | no | `4000` | Host port for the API |
| `DB_HOST_PORT` | no | `5433` | Development only: host port for Postgres |
| `API_BIND` | no | `127.0.0.1` | Production only: host interface the API is published on |
| `TRUST_PROXY` | no | `1` in production | Reverse proxy hops in front of the API (`true`, `false` or a number) |
| **Mail** | | | |
| `SMTP_URL` | no | none | SMTP transport for invites, resets and email notifications |
| `MAIL_FROM` | when `SMTP_URL` is set | none | Sender address |
| **GitHub** ([setup](#github)) | | | |
| `GITHUB_HOST` | no | `github.com` | GitHub host |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG` | for GitHub | none | The App's ID and slug |
| `GITHUB_APP_PRIVATE_KEY` | for GitHub | none | The App's private key on one line, newlines written as `\n` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | for GitHub | none | The App's OAuth client credentials |
| `GITHUB_WEBHOOK_SECRET` | for GitHub webhooks | none | The secret set on the App's webhook |
| **GitLab** ([setup](#gitlab)) | | | |
| `GITLAB_OAUTH_HOST` | no | `gitlab.com` | Host of the GitLab OAuth application |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | for GitLab OAuth | none | OAuth application credentials; tokens work without them |
| **Sign-in providers** ([setup](#sign-in-with-github-or-gitlab)) | | | |
| `GITHUB_LOGIN_HOST` | no | `github.com` | GitHub host for sign-in |
| `GITHUB_LOGIN_CLIENT_ID`, `GITHUB_LOGIN_CLIENT_SECRET` | for GitHub sign-in | none | A GitHub OAuth App's credentials, separate from the GitHub App |
| `GITLAB_LOGIN_HOST` | no | `gitlab.com` | GitLab host for sign-in, gitlab.com or self-managed |
| `GITLAB_LOGIN_CLIENT_ID`, `GITLAB_LOGIN_CLIENT_SECRET` | for GitLab sign-in | none | A GitLab application's credentials (scope `read_user`), separate from the forge one |
| **Models** | | | |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | no | none | Server-wide model keys, used when a workspace has not stored its own |
| **Worker** ([tuning](#worker-tuning)) | | | |
| `WORKER_POLL_INTERVAL_MS` | no | `2000` | How often to poll for queued reviews |
| `WORKER_CONCURRENCY` | no | `2` | Reviews one worker runs at once |
| `WORKER_USER_CONCURRENCY` | no | `2` | Reviews one workspace may have running at once |
| `WORKER_LOCK_TIMEOUT_MS` | no | `900000` (15m) | Silence after which a review is treated as abandoned and retried |
| `WORKER_MAX_ATTEMPTS` | no | `3` | Attempts per review, in total |
| `WORKER_HEARTBEAT_INTERVAL_MS` | no | `60000` (60s) | Lock refresh interval; must be below `WORKER_LOCK_TIMEOUT_MS` |
| `WORKER_MAX_RUN_MS` | no | `1800000` (30m) | Longest a review may take |
| `WORKER_SHUTDOWN_DRAIN_MS` | no | `600000` (10m) | How long a stopping worker waits for in-flight reviews |
| `WORKER_STOP_GRACE_PERIOD` | no | `15m` | Production Compose only: how long a stop waits before killing the worker |
| `REVIEW_RETENTION_DAYS` | no | unset (keep everything) | Fallback retention period; see [Retention](#retention) |
| **Production image** | | | |
| `SENTRYWARD_VERSION` | yes in production | none | Image tag to run, for example `0.4.0` |

### Worker tuning

The worker polls the `review_jobs` table and claims jobs with
`FOR UPDATE SKIP LOCKED`, so several workers can run side by side. Tune it with
`WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_LOCK_TIMEOUT_MS`,
`WORKER_MAX_ATTEMPTS`, `WORKER_HEARTBEAT_INTERVAL_MS`, `WORKER_MAX_RUN_MS` and
`WORKER_SHUTDOWN_DRAIN_MS` (see **Upgrades** under [Deploying](#deploying)).

- **Heartbeat:** while a job runs, the worker refreshes its lock every
  `WORKER_HEARTBEAT_INTERVAL_MS` (default 60s), so a long-but-healthy review is
  not reclaimed as a dead worker. Keep it well below `WORKER_LOCK_TIMEOUT_MS`;
  the server refuses to start otherwise.
- **Maximum run time:** `WORKER_MAX_RUN_MS` (default 30m) is the longest a
  review may take. A run past it is failed, healthy or not, and its slot freed,
  so raise it for repositories with very large reviews.
- A run that loses its job this way, or to stale-lock recovery, stops and
  publishes nothing more.

## Forge connections

> [!NOTE]
> Manual reviews only need API access to the forge. Automatic reviews also need
> the forge to reach `API_PUBLIC_URL` over the internet; for local development
> use a tunnel.

In production, self-hosted forge hosts must use https and resolve to public
addresses.

### GitHub

Create a GitHub App (Settings, Developer settings, GitHub Apps) and put its
details in `.env`:

1. **Setup URL:** `<CLIENT_ORIGIN>/api/connections/github/callback`, with
   **Request user authorization (OAuth) during installation** checked.
   Sentryward uses that OAuth code to confirm the installing user can actually
   access the installation.
2. **Repository permissions:** see the table below.
3. **Webhook:** URL `<API_PUBLIC_URL>/api/webhooks/github`, a secret in
   `GITHUB_WEBHOOK_SECRET`, and the events **Pull request**, **Issue comment**,
   **Pull request review comment** and **Installation**. Review comment events
   are how [replies to findings](#replying-to-findings) arrive; an App created
   before they existed needs the event added in its settings.
4. **Credentials:** copy the App ID, slug, client ID, a client secret and a
   generated private key into the `GITHUB_APP_*` variables.

| URL | Local development | Production |
| --- | --- | --- |
| Setup URL | `http://localhost:5173/api/connections/github/callback` | `https://<your host>/api/connections/github/callback` |
| Webhook URL | `<API_PUBLIC_URL>/api/webhooks/github` (needs a tunnel) | `https://<your host>/api/webhooks/github` |

| Permission | Access | Used for | Without it |
| --- | --- | --- | --- |
| Pull requests | read and write | Reading changes, posting reviews, labels, description updates | Reviews cannot run or publish |
| Contents | read | Diffs, files and `.sentryward.yaml` | Reviews cannot run |
| Commit statuses | read and write | The `sentryward/review` status | No commit status |
| Issues | read | Linked and related issues in the walkthrough | Those parts are skipped with a warning |
| Checks | read | [Static analysis findings](#static-analysis-findings) | They are skipped with a warning |
| Metadata | read | Required by GitHub | |

### GitLab

GitLab connects in one of two ways. Either way, automatic reviews need
Maintainer access (see below).

**Access token.** Use a personal, project or group access token with the `api`
scope and at least Developer access. Self-hosted instances work by entering
their host. A project or group access token posts as a GitLab bot user, so
prefer a token when comments should not come from a person.

**OAuth ("Connect with GitLab").** Register an application on the instance
(User, Group or Admin settings, Applications) and put its details in `.env`:

- **Redirect URI:** `<CLIENT_ORIGIN>/api/connections/gitlab/oauth/callback`
  (for local development
  `http://localhost:5173/api/connections/gitlab/oauth/callback`). It goes
  through the client origin so the browser sends the session cookie with it.
- **Scope:** `api`. GitLab has no narrower scope that allows posting comments,
  discussions and commit statuses.
- **Confidential** checked, and **Expire access tokens** on. Sentryward stores
  the access and refresh tokens encrypted and refreshes the access token
  shortly before it expires. GitLab rotates the refresh token on every refresh,
  so refreshes of one connection are serialized; if GitLab refuses one (the
  application was revoked, the user removed), the connection shows as inactive
  and reviews fail asking you to reconnect.
- **Variables:** `GITLAB_OAUTH_HOST` (default `gitlab.com`),
  `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET`. One instance per
  deployment; tokens still work for any other.

An OAuth connection acts as the person who signed in: reviews, comments and
statuses appear under their name, and it can reach what they can.

**Automatic reviews** need a project webhook, which Sentryward registers when a
repository is enabled at `API_PUBLIC_URL`. That takes **Maintainer** access;
with only Developer access the repository is enabled for manual reviews and the
dashboard says why automatic ones are off. GitLab must be able to reach
`API_PUBLIC_URL`; for local development use a tunnel.

## Publishing to the forge

When a review starts, Sentryward posts a "reviewing" summary comment and, with
`output.post_check` on, sets a pending `sentryward/review` commit status. When
it finishes it publishes, each step independently:

- **Inline comments** for actionable findings only.
  - `output.inline_min_severity` (default `info`) posts threads only for
    findings at or above that severity, and `output.max_inline_comments`
    (default none) caps the threads on the change, the most severe first.
    Threads posted by earlier runs keep their place and count toward the cap,
    so a later run only opens threads for the slots left. Findings either one
    holds back are written out in full in the summary comment, under "Not
    posted inline"; a finding that already has a thread never is.
  - GitHub: one review posted as `COMMENT`, never approve or request changes.
    GitLab: one discussion per finding.
  - Suggestions use each forge's suggestion syntax.
  - Each comment carries a hidden fingerprint, so a later run never posts the
    same finding twice, even if Sentryward's own records are lost.
- **Resolved threads** (`output.resolve_fixed_threads`, on by default):
  - When a run reviews a file and no longer reports a finding, its inline thread
    is resolved (GitHub through GraphQL, GitLab by resolving the discussion).
  - If the finding comes back, the thread is reopened, but only when Sentryward
    resolved it: a thread a person resolved stays resolved.
  - Only threads Sentryward opened, and only for findings whose state changed,
    are touched. A thread update that fails is retried on later runs until it
    lands. Ignored findings are left alone.
- **The summary comment**, edited in place: the markdown served by
  `GET /api/reviews/:id/markdown`.
  - One comment carries both what the change does (the PR summary, when
    `output.walkthrough` is on) and what the review found. The dashboard and
    these docs call it the PR summary; the config keys keep the name
    `walkthrough`.
  - With `output.review_stats` on, it ends with a line naming the commit,
    models and coverage.
  - With `output.post_summary` off, the PR summary is posted as a comment of
    its own.
  - With `output.summary_only_with_findings` on, a completed review with no
    findings starts no summary comment (the PR summary included), and the
    "reviewing" note only replaces an earlier summary, never starts one. A
    summary an earlier run posted is still updated, so it never keeps showing findings that are gone. The
    commit status still reports the verdict, and a partial or failed review is
    always posted.
  - `output.summary_location` is accepted but ignored, and a walkthrough block
    an earlier version wrote into the description is removed on the next
    review.
- **The PR summary's optional parts**, each with its own switch (only related
  issues and the blast radius segment are on by default):

  | Key | Adds |
  | --- | --- |
  | `output.estimate_effort` | The review effort estimate |
  | `output.sequence_diagrams` | A Mermaid sequence diagram of the main flow |
  | `output.assess_linked_issues` | How well the change addresses the issues it closes ("fixes #12" style references on GitHub, GitLab's own closing issues on GitLab) |
  | `output.related_issues` | Possibly related issues found by searching the tracker for the title's keywords |
  | `output.walkthrough_labels` | The labels segment of the PR summary's meta line |
  | `output.walkthrough_blast_radius` | The blast radius segment of the meta line |

  Only issues the forge returned are ever shown. Hiding the labels or blast
  radius segments only changes the comment text, not the native labels below.
  What each part adds to the PR summary's model call: a sequence diagram and
  the high-level summary make the model write more, linked and related issues
  add the issues' text to the prompt (only when there are any), and the effort
  estimate is made either way, for the effort label.
- **The high-level summary** (`output.high_level_summary`): release notes by
  default, or whatever `output.high_level_summary_instructions` asks for.
  `output.high_level_summary_placement` puts it in the PR/MR description (the
  default, between hidden markers at the end, replaced on each run and never
  read back as the author's text) or in the PR summary (`walkthrough`).
- **Labels**, when `output.blast_radius_label` or `output.effort_label` is on:
  the PR summary's estimates as native labels such as `Large blast radius` or
  `10-20 Minutes`. They need the PR summary, but not the matching text
  (`output.estimate_effort`, `output.walkthrough_blast_radius`). A later run swaps a changed estimate's label. GitHub and
  GitLab only; on GitHub both labels and the cleanup of old description blocks
  use the Pull requests (write) permission.
- **The commit status**, when `output.post_check` is on (it is off by
  default): `success` (pass), `failure` (blocked) or `error` (incomplete;
  GitLab shows it as `failed`), linking to the review in the dashboard. Turn it
  on for branch protection to require it.

The defaults are a quiet setup, the Display tab's Standard preset: inline
comments, one summary comment and a short PR summary, without the counts,
lifecycle and stats lines, the labels, diagrams or the commit status. Turn the
inline and summary comments off with `output.post_inline` and
`output.post_summary`, the commit status on with `output.post_check`, and the PR
summary off with `output.walkthrough`. If
publishing fails, the review is kept and the job is marked partial with the
reason.

## Replying to findings

Reply in the thread of one of Sentryward's inline comments to act on that
finding:

- **Ignore it:** `/sentryward ignore false-positive [note]` or
  `/sentryward ignore intentional [note]` (at the start of a line; the rest of
  the line is the note) ignores the finding with that reason, as the dashboard
  would, and Sentryward acknowledges it in the thread. With
  `review.suppress_ignored`, later reviews of the change do not raise it again.
  Reopen it from the findings page.
- **Ask about it:** anything else is a question. Sentryward answers once,
  briefly, from the finding and the code around it at the change's head, using
  the review model. The reply is treated as untrusted data, never as
  instructions.

Rules and limits:

- Only people who can push (GitHub owners, members and collaborators; GitLab
  Developer or above) get a response.
- Sentryward never answers its own comments, acts on at most 10 replies per
  PR/MR per hour (the rest are dropped silently) and handles a redelivered event
  once.
- Replies are answered by the worker; `triggers.replies` turns them off, read
  like the rest of the configuration from the change's base revision.
- GitHub needs the **Pull request review comment** webhook event: per-repository
  hooks registered before this existed get it when the repository is disabled
  and enabled again. GitLab delivers diff thread notes through the note events
  its hook already subscribes to.

## Automatic reviews

**When a review runs**

- A PR/MR is reviewed when it opens, reopens, leaves draft or receives new
  commits. A commit that was already queued or reviewed is never reviewed again,
  so redelivered webhooks are harmless, and a newer push supersedes a review
  still waiting in the queue.
- Comment `/sentryward review` on a PR/MR to ask for a review of its current
  head. Only people who can push (GitHub owners, members and collaborators;
  GitLab Developer or above) can.

| Key | Values | Effect |
| --- | --- | --- |
| `triggers.review` | `manual`, `published` (default), `all` | What is reviewed automatically when it opens, reopens or leaves draft: nothing, non-drafts, or drafts too |
| `triggers.review_on_push` | boolean | Whether new commits are reviewed again |
| `triggers.full_review_on_push` | boolean | Review the whole change on every push instead of incrementally |
| `triggers.command` | boolean | Turns `/sentryward review` off when `false` |
| `triggers.summary` | `published` (default), `manual` | Limits the PR summary in automatic reviews; `manual` leaves it to requested reviews |
| `triggers.abort_on_close` | boolean (default on) | Cancel and stop reviews when the PR/MR is closed or merged |

Older settings keep their meaning: `triggers.on_push: false` reads as
`review: manual` and `triggers.drafts: true` as `review: all`, unless the same
layer sets `review`.

**Skipping**

Automatic reviews are skipped when:

- the title contains a phrase in `triggers.ignore_titles` (ignoring case),
- the author or whoever pushed is in `triggers.skip_authors`,
- the change carries a label in `triggers.skip_labels` (exact and
  case-sensitive), or
- the source or target branch name contains an entry of
  `triggers.skip_source_branches` / `triggers.skip_target_branches`.

A manual review or `/sentryward review` is never skipped by these lists. All of
this is checked by the worker with the full configuration, so a skipped review
shows in the dashboard with the reason.

**Incremental reviews**

A review triggered by a push is incremental: only the files the new commits
touched since the last completed review are reviewed again (each with its whole
PR/MR diff), and that review's findings on the other files are carried over, so
they stay open and still count toward the verdict. A force push or rebase, a
partial or failed last review, a comparison the forge cannot answer, and manual
or `/sentryward review` requests get a full review.

**What changed since the last review**

Every review after the first, incremental or full, says in the summary comment
what changed since the last one:

| Outcome | Meaning |
| --- | --- |
| **new** | First reported in this review |
| **still open** | Reported earlier and still there, including a finding that moved to another file |
| **reopened** | Fixed or invalidated by an earlier run, and reported again |
| **fixed** | Its file was reviewed and the finding is gone |
| **invalidated** | Its file was renamed, deleted or dropped from the change, or the finding moved, so it no longer applies but was not fixed |

- Only files are compared, not lines, so code deleted within the same file
  counts as fixed.
- A finding counts as moved only when the same problem now appears in a file
  the change adds or renames, and it is the only one of its kind on both sides;
  anything looser would turn real fixes into invalidated findings.
- Each list in the comment shows at most 20 findings. The block is only there
  with `output.finding_lifecycle` on (off by default).
- The findings page filters by the same outcome ("Last review"), and
  invalidated findings do not count toward the resolution rate.

**Limits and cancellation**

- Each workspace has at most `WORKER_USER_CONCURRENCY` reviews running at once
  (the name predates workspaces), and a repository holds at most 10 queued.
- With `triggers.abort_on_close` (the default), closing or merging a PR/MR
  cancels its queued reviews, and a running review stops: the worker checks the
  change before it starts, every 15 seconds while it runs (aborting model calls
  in flight) and before publishing. A cancelled review publishes nothing more,
  replaces its progress comment with a short "Review cancelled" note and closes
  its pending commit status as `error`. The webhook decides on queued reviews
  from the dashboard settings; the worker uses the full configuration,
  repository file included.
- Turning a repository off (or the GitHub App losing access to it) cancels its
  queued and running reviews. A running one stops before its next model call or
  publishing step, and its pending commit status is set to `success` ("Reviews
  turned off for this repository") so a required check does not stay blocked.
  Turning the repository back on lets automatic triggers review those heads
  again.

**Caching**

The worker keeps a small in-memory cache of what a commit fixes: the repository
config file at the base revision and the change's diff for a given base and
head. Reruns of the same head skip those forge calls; titles, descriptions,
labels and state are always read fresh. `review.disable_cache` turns it off.
Set in the dashboard it covers every read; set in `.sentryward.yaml` the diff is
fetched again once the file has been read.

**File context**

With `review.file_context` (the default), each review pass also sees read-only
code around the diff, read from the head revision:

- the enclosing function or class of each hunk,
- the file's imports,
- the definitions of functions the diff calls through relative imports, and
- call sites of functions it changes in files the change does not touch.

Head files go through the same cache; caller lookups use the forge's code
search (GitHub only indexes the default branch, GitLab searches the head) and
are never cached. Context only fills what a pass has left once its diff is
planned, so it never displaces a hunk or makes a review partial, and a file or
search that cannot be read only costs a warning. Findings on context lines are
dropped unless `review.full_file` is on.

**Impact depth**

`review.impact_depth` (1 to 3, default 2; the `fast` profile uses 1) is how many
hops of callers that context follows. At 2, a pass also sees who calls the
functions that call the changed code, so a changed signature, return shape or
thrown error that breaks code further away is visible.

- Callers of declarations the diff changed or removed are searched first and
  marked as such, and further hops are the first context to go when a pass is
  short of room.
- A review makes at most 8 caller searches in all, the first 5 for names the
  change itself defines, and does not trace through generic method names such
  as `run` or `handle`.
- Findings that report a broken contract list the files of the callers it
  breaks as **Affected** in the comment.

**Risky areas**

The walkthrough also flags risky areas next to the blast radius: authorization
checks, database writes and schema changes, and API routes the diff defines
(calls through HTTP clients such as `axios` or `api` are not routes), plus route
handlers and auth modules it reaches through the traced callers. Test files
never count.

- They are found by pattern, given to the walkthrough model, and raise the
  blast radius it reports (never lower it): any risky area, changed or reached
  through callers, makes it at least `medium`, and only a removed authorization
  check makes it `large`.
- Incremental reviews keep the areas the last review reached through callers.
- `output.walkthrough_blast_radius` hides them with the blast radius, in the
  comment and on the dashboard.

## Notifications

Under **Notifications**, workspace admins add targets that hear about finished
reviews. Members can see them; only admins add, edit, test or remove them.
Every member can also switch on email about their own pull and merge requests
(see [Personal notifications](#personal-notifications)). Each target picks its
events:

| Event | Sent when |
| --- | --- |
| **Blocked** | The review found blocking issues |
| **Resolved** | The review passed, and the previous finished review of the same pull or merge request was blocked. A partial review with no blocking findings does not count, since it may have skipped the code the blockers were in |
| **Failed** | The review could not run or finish (no model key, the forge unreachable, the maximum run time or a worker that stopped responding) |
| **Completed** | Any finished review, blocked or not. Skipped and cancelled reviews never notify |

A target gets one delivery per review, named after the most specific event it
listens for (failed, then blocked, then resolved, then completed).

**Scope.** Each target can also narrow which reviews it hears about:

- **Repositories:** all (the default), or only the chosen repositories of the
  workspace.
- **Minimum severity:** any (the default), or only reviews with at least one
  finding at or above minor, major or critical.
- **Only when the verdict changes:** skip a review whose verdict matches the
  previous finished review of the same pull or merge request. The first review
  of a change always counts as a change.

The "previous review" is the newest completed or partial review of the same
change that finished earlier, however either was started (push, rerun,
comment or manual); failed runs are passed over, so pass, failed, pass is not
a change. **Failed** and **Resolved** deliveries ignore the severity and
verdict filters (a failure has neither, and a resolved review usually has
fewer findings); the repository filter applies to every event. Deleting a
repository, or the connection it came through, removes it from every target's
list; a target left with none is paused ("Paused: its repositories were
removed") rather than widened to every repository, and cannot be switched back
on until repositories (or All) are saved when editing it. The list shows a
target's scope under its name, for example "acme/payments · ≥ major · verdict
changes".

**Digests.** Each target picks how reviews reach it under **Delivery**: **Each
review** (the default), or a **Daily digest** or **Weekly digest** at a chosen
hour:00 (and, weekly, a chosen day) in a chosen timezone, which defaults to the
browser's. A digest target still applies its events and scope to every review,
but instead of sending each match it holds it in the outbox until the digest is
due, then sends one message summing up the period: how many reviews, by verdict,
how many failed and how many were resolved, the five repositories with the most
blocked reviews (failed runs not counted), the changes still blocked (a held
blocked review whose change has no newer finished review that passed, held or
not, with links to the change and the review), and the failed reviews with
their errors. The review list stops at 200 (`truncated` counts the rest) and
the blocked list at 50 (`blockedTruncated`); the counts cover every one. A
period with no matching reviews sends nothing. Because held reviews
are rows in the outbox, a worker that was down at the due time builds the digest
on its next poll, and each digest is queued exactly once (then sent and retried
like any other delivery). Times follow daylight saving: an hour skipped by a
spring-forward change goes out at the first valid time after it. A stored
timezone the runtime no longer knows is scheduled in UTC, and a digest that
fails to build is retried an hour later without holding up other targets'.
A workspace's privacy retention also deletes held reviews older than its
period, so they never outlive the reviews they describe. Pausing a
digest target drops what it held, like any queued delivery. Switching a target
back to **Each review** sends whatever it held as a final digest on the worker's
next poll (switching to a digest again before then folds it into the next
one); changing a digest's schedule keeps what is held for the next one. The
list shows the schedule under the target's name, for example "Weekly digest ·
Mon 09:00 Europe/Berlin · 3 reviews held".

**Pausing.** Admins can switch a target off in the list to pause its deliveries
while keeping its events, recipients, URL and secret. Pausing drops deliveries
rather than holding them: a review that finishes while a target is paused is
never sent to it, even after it is switched back on, and a delivery still
waiting for a retry when its target is paused (by an admin or automatically)
is dropped too. A paused target
shows as switched off, can be filtered by status, and still accepts test
deliveries, so it can be checked before it is switched back on.

**Auto-pause.** A target whose deliveries keep failing is switched off for you.
Each delivery that fails for good (out of retries, or refused) adds one to the
target's count of failures in a row, across reviews; a successful delivery,
tests included, sets it back to zero. When the count reaches the workspace's
limit (**Auto-pause after** at the top of the Notifications page's **Failing
targets** tab, 5 by default, Never to turn it off) the target is paused. An endpoint that says it no
longer exists, `410 Gone` from any target or `404` from Slack (a deleted
incoming webhook answers `no_service`), pauses its target at once. The reason
(for example "Auto-paused: HTTP 410 Gone" or "Auto-paused after 5 failed
deliveries in a row (last: HTTP 503)") shows under the target's name and in its
edit panel, and when mail is configured each owner and admin of the workspace
is emailed once, with a link straight to that tab. The **Failing targets** tab
(`/notifications?tab=failing`, open to members too) lists every target that
needs a look, with a summary such as "1 paused · 1 failing · 1 retrying":
**Paused** (auto-paused, with what to do about it: a deleted Slack webhook has
to be added again, a target that kept failing can be tested and resumed),
**Failing** (on, with failures in a row shown against the limit) and
**Retrying** (a delivery waiting for its next try, even when a newer one went
through). Each row shows the last delivery's status or error and when the next
try is, and an older delivery still being retried behind it on its own line. Admins can **Send test**
from the row and **Resume** a paused target (a passing test offers to resume it
too), except one paused because its repositories were removed, which is
switched back on by saving repositories when editing it; everyone can open its delivery history. The tab's badge is red when a
target is paused. The list refreshes every 30 seconds while a delivery is
pending. Resuming the target (or switching it back on or off in the Targets
tab) clears the reason and the count. Failed test deliveries never count, so checking a broken target does not
pause it.

There are three kinds:

- **Webhook**: a `POST` with a JSON body and these headers:

  | Header | Value |
  | ------ | ----- |
  | `X-Sentryward-Event` | The `event` of the body |
  | `X-Sentryward-Delivery` | The `deliveryId` of the body, the same on every retry of a delivery |
  | `X-Sentryward-Timestamp` | When this attempt was sent, in unix seconds |
  | `X-Sentryward-Signature-V2` | `sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` keyed with the signing secret; during a secret rotation, two comma-separated values |
  | `X-Sentryward-Signature` | Deprecated: `sha256=<hex>` of the raw body alone (two values during a rotation, like V2), removed in the next minor release |

  The signing secret is shown once when the target is added. Admins can change
  a webhook's or Slack target's URL from **Edit** without losing its events,
  scope, secret or delivery history; the new URL is checked like a new
  target's, and deliveries already queued go to it. **Rotate secret** in a
  webhook's menu issues a new secret, shown once. For the next 24 hours the
  previous secret keeps working: each signature header carries
  `sha256=<new>,sha256=<old>` (new first), so a receiver still holding the old
  secret accepts deliveries while it is updated. After that only the new
  secret signs. Rotating again within the 24 hours replaces the older of the
  two. A receiver that compares the whole header as one string (rather than
  checking each value, as below) rejects deliveries during that window.

  ```json
  {
    "deliveryId": "6f1c2a4e-...",
    "timestamp": "2026-11-11T09:30:00.000Z",
    "event": "blocked",
    "review": { "id": "...", "url": "https://sentryward.example.com/reviews/...", "status": "completed", "verdict": "blocked", "error": null, "trigger": "webhook" },
    "repository": { "provider": "github", "fullPath": "acme/api" },
    "change": { "number": 42, "title": "Add login", "url": "https://github.com/acme/api/pull/42", "headSha": "9fceb02..." },
    "findings": { "total": 3, "bySeverity": { "major": 1, "minor": 2 } }
  }
  ```

  `change.title`, `change.url` and `findings` are `null` for a review that
  failed before it ran. `review.trigger` is `manual`, `webhook` or `comment`.
  `review.trigger` and `change.headSha` are missing from deliveries queued (or
  held for a digest) before they were added. `change.url` is `null` when the
  forge's URL is not http(s). The body's `timestamp` is the same second as the
  `X-Sentryward-Timestamp` header, in ISO 8601. New keys may be added to the
  body, so receivers should ignore keys they do not know.

  To verify a delivery, recompute the signature over the timestamp header, a
  dot and the raw body exactly as received, compare it in constant time with
  each comma-separated value of the header (accept if any matches), and reject
  timestamps more than about 5 minutes from your clock, so a captured delivery
  cannot be replayed later:

  ```js
  import { createHmac, timingSafeEqual } from "node:crypto";

  function verify(secret, headers, rawBody, toleranceSeconds = 300) {
    const timestamp = headers["x-sentryward-timestamp"];
    const received = headers["x-sentryward-signature-v2"] ?? "";
    if (!/^\d+$/.test(timestamp ?? "")) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
    const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`);
    // Two values while the secret is being rotated; either may be yours.
    return received.split(",").some((value) => {
      const candidate = Buffer.from(value.trim());
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
  }
  ```

  Receivers that check `X-Sentryward-Signature` (body only) keep working for
  this release; move them to `X-Sentryward-Signature-V2` before it is removed. `event` (and the header) is `failed`, `blocked`,
  `resolved`, `completed`, `test` or `digest`. A digest carries the period's
  reviews, each in the shape above:

  ```json
  {
    "event": "digest",
    "schedule": "weekly",
    "period": { "from": "2026-11-02T08:00:00.000Z", "to": "2026-11-09T08:00:00.000Z", "timeZone": "Europe/Berlin" },
    "counts": { "reviews": 12, "failed": 1, "resolved": 2, "byVerdict": { "pass": 8, "blocked": 3, "error": 0 } },
    "topBlockedRepositories": [{ "provider": "github", "fullPath": "acme/api", "blocked": 2 }],
    "blocked": [{ "event": "blocked", "review": { "...": "..." }, "repository": { "...": "..." }, "change": { "...": "..." }, "findings": { "...": "..." } }],
    "blockedTruncated": 0,
    "reviews": ["... every review, blocked and failed first ..."],
    "truncated": 0
  }
  ```

  `schedule` is `daily`, `weekly`, or `null` for the final digest sent after a
  target switches back to each review.
- **Slack**: an incoming-webhook URL, posted a Block Kit message: a headline
  with an emoji per event ("🔴 Review blocked · acme/api #42"; also "⚠️ Review
  failed", "✅ Blocking issues resolved", "🟢 Review completed" and "🔔 Test
  notification"), the title, the findings by severity ("3 findings   1 major ·
  2 minor") or a failed review's error, and **View review** and **Open PR**
  (**Open MR** on GitLab) links, the second only when the change has an
  http(s) URL. A
  plain `text` fallback (the headline without the title) is what
  notifications and screen readers show. A digest is one message
  with the counts, the most blocked repositories, up to 20 still-blocked
  changes and 5 failed reviews, each linking to its review.
- **Email**: chosen members of the workspace, through the configured mail
  transport (`SMTP_URL`). Members who leave are no longer emailed. A review's
  email has a text and an HTML part with the same content: the headline,
  repository and number, title, the findings by severity or the error, **View
  review** and **Open pull request** links, and a footer naming the target
  ("You get this as a recipient of "Leads alerts""). A digest is
  a plain-text email whose subject sums up the counts (for example "Weekly
  digest: 12 reviews, 3 blocked, 1 failed, 2 resolved, 8 passed").

**Delivery.** **Send test** posts a sample (`"event": "test"`) and reports the
outcome; tests are sent once, at once, and never retried. A review's deliveries
go through an outbox: when the review reaches its final status, one pending
delivery per target is written in the same step that marks the review notified,
so a worker restart cannot lose them (and a worker that stopped between
storing a review and queueing its deliveries is covered too: the poll loop
queues them for any review finished more than a minute and less than 24 hours
ago that has none), and the worker's poll loop sends them
apart from the review slots (up to 10 at a time), so a slow or hanging endpoint
never delays a review. A failed delivery is logged (`[notify] ...`) and never
changes the review.

A delivery is tried at most 5 times, waiting 1 minute, 5 minutes, 30 minutes
and 2 hours between tries. Timeouts, connection errors, `408`, `429` and `5xx`
responses are retried; a `429` with `Retry-After` waits as long as it asks (up
to 6 hours). Other `4xx` responses, an unreadable or refused URL, mail not being
configured, and an email target with no members left fail at once. An email
that reached some of its recipients is not retried, so nobody gets it twice. A
delivery the endpoint accepted is never sent again, with one exception: a worker
that dies after sending but before recording it sends it again once its claim
goes stale (5 minutes), so a receiver that must not act twice should dedupe on
`deliveryId` (the same on every retry of a delivery). URLs are stored encrypted, and only their
host is ever shown again. In production a URL must be https and resolve only to
public addresses, the same rule as self-hosted forge hosts, checked when the
target is saved and again before each delivery; redirects are not followed.

**Delivery log.** Every delivery, tests included, is recorded with its event,
outcome (`pending`, `sent` or `failed`), the HTTP status a failing endpoint
answered with or the error otherwise, how many tries it took, and when it was
queued. A pending delivery that already failed keeps its last status or error
and shows when it is tried next. The list's **Last delivery** column shows each
target's latest one (for example "Sent · 4 minutes ago", "Retrying · 503 · 4
minutes ago", "Failed · 503 · 1 hour ago", or "Never"), and **View deliveries** in a target's
menu opens its history, linking each delivery to its review. Reviews a digest
target is holding are not deliveries yet and do not show; the digest does, once
queued. Admins and members
can both read it. Stored errors have the target URL cut out first, since the URL
can be the credential. The worker's retention pass keeps the last 30 days (or
the workspace's privacy retention, when that is shorter), and at most the 100
newest deliveries per target, never removing one still pending; removing a
target removes its log.

### Personal notifications

Any member, admin or not, can switch on email about reviews of the pull and
merge requests they opened, in the **Your pull requests** card at the top of
the Notifications page, and pick which events (blocked, failed, resolved,
completed; failed, blocked and resolved by default). It needs mail configured.
The setting is per workspace and visible only to that member: personal
targets never appear among the workspace's targets, admins cannot edit or
test them, and leaving the workspace deletes them.

A change is recognised as yours through a linked sign-in account: the forge's
user id of whoever opened it (recorded when the worker fetches the change)
must match a GitHub or GitLab identity you linked under **Settings, Sign-in
methods** on the same host as the connection the repository came through.
Ids survive renames, and the provider verified the account when you linked
it, so nobody can claim someone else's changes. The card lists any forge host
in the workspace you have no linked identity for. Reviews of changes fetched
before this was added, or that failed before the change was fetched, carry no
author and are not sent.

Personal email goes through the same outbox as targets (retries, delivery
log, auto-pause), one email per review. When a workspace email target that
lists you already sends you a review, the personal email for it is skipped,
so nobody gets the same review twice. An auto-paused personal target shows
its reason in the card, and switching it back on clears it. Only changes you
opened count; reviews where you are a requested reviewer do not.

## Review configuration

Settings resolve in this order, highest first:

1. Overrides from whatever triggered the review
2. `.sentryward.yaml` (or `.sentryward.yml`; the first found wins, they are not
   merged) in the repository, read from the PR's **base** revision so a change
   cannot loosen its own review
3. Repository settings saved in the dashboard (ignored while the repository
   follows the global config, which is the default for new repositories)
4. The global config saved on the Review settings page, shared by all of a
   user's repositories
5. The selected profile: `balanced` (default), `fast`, `strict`, `security`
6. Built-in defaults

A field set explicitly in any layer beats the profile. An invalid repository
file is ignored as a whole and reported as a warning; the review still runs. The
file cannot hold API keys, tokens or endpoints.

### LLM connections and custom endpoints

Add and verify provider credentials in LLM Connections, then select one in
Review settings > LLM. Global configuration requires a connection; a repository
can inherit it or select another saved connection. The selection is a live
reference, so replacing its key or changing its custom host updates every
configuration that uses it.

**Custom hosts.** A connection with a custom host sends every model call to that
compatible proxy. The model's provider prefix still picks the request format
(`openai/` uses chat completions), and the rest of the id is passed through as
is, slashes and parentheses included. Without a custom host, every configured
model must use the selected connection's provider.

For example, to use an OpenAI-compatible router such as 9router: save its key
and host under OpenAI in LLM Connections, select the OpenAI connection in Review
settings > LLM, and use a model id the router serves, such as
`openai/cx/gpt-5.6-sol(medium)`.

**Test model.** To check a model before relying on it, choose **Test model** in
a connection's actions menu. It runs one short generation with the stored
credential, the same way a review would, and reports the response time and
token usage, or why it failed: the key was rejected, the host does not serve
that model, the host could not be reached, or the model did not answer in the
JSON format reviews need. The test uses a small amount of the connection's
quota.

> [!TIP]
> The worker runs in a container, where `localhost` is the container itself;
> `host.docker.internal` reaches a proxy running on the host.

### Model prices and benchmarks

Review costs are estimates worked out when a review runs, from a built-in price
table.

**Custom prices.** Under **Model prices** on the LLM Connections page,
workspace admins can set their own price for a model (USD per million tokens for
input and output, optionally cache reads, cache writes and reasoning).

- A price is keyed by `provider/model` or by the id without its provider prefix
  (for a router id such as `openai/cx/gpt-5.6-sol`, `cx/gpt-5.6-sol` or
  `gpt-5.6-sol`; the longer match wins).
- A saved price's model id is fixed: to rename one, remove it and add it again.
- A workspace price wins over the built-in one; Ollama models cost nothing
  unless priced.
- A model neither prices is shown with an unknown cost rather than $0, and the
  card lists the models recent reviews called that have no price.
- Prices apply to reviews from then on; past reviews keep the cost they
  recorded.

**Benchmarks.** The **Benchmarks** page compares models over a period,
optionally for one repository:

- per model: cost (total and per review), tokens and mean call time;
- per repository: cost, median review duration and the duplicate rate (findings
  dropped as repeats of another);
- per language and per category: how each model's findings turned out
  (confirmed: resolved by a later run; false positive: dismissed as one), naming
  the best model among those with at least five decided findings.

Confirmed and false-positive rates are over decided findings (confirmed plus
false positives), as in the findings calibration stats, so findings still open
don't count against a model. Cost per review is over the reviews that called a
model.

### Model capabilities

Thinking and agentic context depend on what a model supports on the endpoint
that serves it, and that differs per model even on one endpoint: not every
native Anthropic, OpenAI or Google model takes thinking options, Ollama models
differ in tool and thinking support, and proxies (9router, OmniRoute, LiteLLM,
OpenRouter and the like) differ in whether they forward thinking options,
translate them between wire formats or pass tool calls through. Sentryward
records, per connection and model, whether **thinking** works (through the
provider's options, by a model that thinks by itself, or not at all) and whether
**tools** work:

- **Probe.** A passing **Test model** also sends two tiny calls, one with
  thinking options and one with a trivial tool, and stores what each did. A
  review that needs thinking or tools probes a model the first time it is used
  on an endpoint, keyed models from the server environment included. Probe
  tokens are recorded in the review's usage as `probe` calls.
- **Runtime fallback.** A call that the endpoint rejects with a 400 naming
  thinking or tool parameters is retried once without them; thinking that comes
  back with no reasoning is noted as ignored; an agentic pass that gets plain
  text instead of tool calls is read as a static one. Each records a review
  warning and updates the stored capability, so a review never fails because a
  model lacks thinking or tools.
- **Defaults.** Official APIs start from a built-in table of model families;
  Ollama and custom hosts start unknown. Detection overrules the table.

Choose **Capabilities** in a connection's actions menu to see what was found.
When detection is wrong, set **Thinking support** and **Tool support** in Review
settings > LLM. Like endpoints, these settings exist only in the dashboard: a
repository file cannot change how credentials and endpoints are used.

### Thinking and agentic context

**Thinking.** `llm.thinking` (`off`, `low`, `medium`, `high`) lets review passes
reason before answering.

- Each level maps to the provider's own option: an Anthropic thinking budget of
  2,000, 8,000 or 24,000 tokens, an OpenAI reasoning effort of the same name, or
  a Google thinking budget.
- The budget is added on top of `max_tokens` (Anthropic counts thinking inside
  it), temperature is not sent while thinking is on, and the prompt ceiling
  leaves room for both.
- `llm.verify_thinking` sets the verifier's level separately (`null` uses
  `thinking`); the walkthrough never thinks.
- The `strict` profile uses `high` and `fast` uses `off`.

**Agentic context.** `review.context: agentic` lets each pass read more of the
repository before it reports. A pass starts from the same diff and gathered
context as a static one, and may call these tools:

| Tool | Does |
| --- | --- |
| `read_file` | Reads at most 400 lines a call, at the change's head revision |
| `search_code` | Searches code; shared by the whole review, since GitHub rate-limits code search |
| `list_dir` | Lists at most 50 entries, directories marked with `/` and symlinks with `@`, to find a changed file's tests or siblings |
| `report_findings` | Reports the pass's findings |

- `review.agent` caps the loop: `max_steps` (8), `max_tool_tokens` (30,000 per
  pass) and `max_searches` (5 per review); the last step can only report.
- What a pass read is shown to the verifier, and usage records each pass's
  steps and tool calls.
- Tool results are content from the change under review, so the tools are
  read-only, scoped to the repository at the head revision, and their output is
  marked as untrusted data in the prompt.
- A model or endpoint without tool support falls back to static context with a
  warning.

### Ollama

Add Ollama under LLM Connections and enter its OpenAI-compatible base URL. For
Ollama running on the Docker host, use `http://host.docker.internal:11434/v1`.
The API key is optional. Select the Ollama connection in Review settings > LLM
and use the `ollama/<model>` form, for example `ollama/qwen3`.

### `.sentryward.yaml` reference

Every key is optional. Values in the example below are the built-in defaults,
except those marked `# example`, which show the format of a key that is empty by
default. The `fast`, `strict` and `security` profiles change some defaults, as
noted in the comments.

<details>
<summary>Full example with every key</summary>

```yaml
# .sentryward.yaml - every key is optional
profile: balanced
llm:
  model: anthropic/claude-sonnet-5-5   # provider/model: anthropic, openai, google or ollama
  fallback_models: []
  walkthrough_model: null   # model for the PR summary; null uses model
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
  walkthrough: true         # the PR summary
  post_inline: true
  inline_min_severity: info # critical | major | minor | info: lower actionable findings go in the summary
  max_inline_comments: null # e.g. 10: cap inline threads, most severe first; the rest go in the summary
  post_summary: true
  summary_only_with_findings: false  # no summary comment for a clean review (one already posted is updated)
  post_check: false         # the sentryward/review commit status
  resolve_fixed_threads: true  # resolve a finding's inline thread once it is fixed
  finding_counts: false     # the findings-count line under the verdict
  finding_lifecycle: false  # what changed since the last review (new, fixed, ...)
  review_stats: false       # the commit/models/coverage line under the summary
  agent_prompts: true       # a prompt for AI agents in each actionable inline comment
  agent_prompt_all: true    # one prompt for every finding in the summary comment
  blast_radius_label: false # e.g. "Large blast radius"
  effort_label: false       # e.g. "10-20 Minutes"
  estimate_effort: false    # review effort in the PR summary
  walkthrough_labels: false # the labels segment in the PR summary (text, not native labels)
  walkthrough_blast_radius: true  # the blast radius segment in the PR summary
  sequence_diagrams: false  # Mermaid sequence diagram in the PR summary
  assess_linked_issues: false
  related_issues: true
  high_level_summary: false
  high_level_summary_placement: description   # description | walkthrough (the PR summary)
  high_level_summary_instructions: ""         # empty: release notes
triggers:
  review: published         # manual | published | all (drafts too)
  review_on_push: true      # review new commits pushed to an open PR/MR
  full_review_on_push: false  # on push, review every file, not only those the new commits touched
  summary: published        # manual | published: PR summary in automatic reviews
  command: true             # allow "/sentryward review" in a comment
  replies: true             # answer replies on Sentryward's inline comments, and "/sentryward ignore"
  abort_on_close: true      # stop a review when its PR/MR is closed or merged
  ignore_titles: ["WIP"]    # example; title contains, ignoring case
  skip_authors: ["dependabot[bot]"]   # example
  skip_labels: ["no-review"]          # example; exact, case-sensitive
  skip_source_branches: ["release/"]  # example; branch name contains
  skip_target_branches: []
ignore_paths: ["**/*.lock", "**/dist/**"]   # example; replaces the default list
instructions: "Controllers stay thin; business logic lives in services."   # example
language_instructions:      # example
  typescript: "Strict mode; no any."
rules:                      # example; team rules, added to the dashboard ones, see "Review rules" below
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

`rules` states a team's conventions once, with a severity, so every review
checks them the same way: architecture boundaries, security requirements,
naming, approved or forbidden libraries, business rules. Each rule takes:

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits, `.`, `-` and `_`, unique in the file. Shown on every finding and in the dashboard. |
| `description` | yes | What the rule requires, up to 1000 characters. For a rule with a `pattern`, its first sentence is the finding's title; a violation the model reports keeps the model's own title. |
| `severity` | yes | `critical`, `major`, `minor` or `info`. A violation blocks when it reaches `review.block_on`, and is reported only at or above `review.severity_floor`. |
| `category` | no | Files the finding, default `maintainability`. Rule findings are reported whatever `review.categories` holds. |
| `paths` | no | Globs the rule applies to; every reviewed file when absent. A violation the model reports under a rule that does not cover its file is dropped (`rule_mismatch`). |
| `pattern` | no | A regular expression (up to 300 characters) checked without a model. RE2 syntax: like JavaScript, but without backreferences or lookarounds, so matching always takes linear time. |
| `good`, `bad` | no | Compliant and violating examples, up to 2000 characters each. |

- **With a `pattern`**, the rule is checked against every added line of the
  files it covers (lines over 2000 characters are skipped), so the same diff
  always gives the same findings. It is never shown to the model and is not
  re-checked by `review.verify`.
- **Without one**, the rule is given to the model with its examples, and a
  violation it reports is filed under the rule with the rule's severity. These
  still go through `require_evidence` and `verify` like any model finding. Their
  text (ids, paths, descriptions and examples) is capped at 16000 characters in
  total.

Both kinds are reported with source `rule` and the rule's id, count towards
`max_findings`, and can be dismissed like any finding. The Findings page's False
positives tab lists found and false-positive counts per rule. Rules are read
from the base revision like the rest of the file, so a pull request cannot
loosen the rules it is reviewed against. An invalid rule (a pattern that does
not compile, a duplicate id) makes the whole file invalid, as with any other
setting.

**Dashboard rules.** Rules can also be set in the dashboard, on the Review
settings page's Guidance tab: in the global config, so they apply to every
repository in the workspace, and in a repository's settings. Unlike other
lists, rules from each layer are combined instead of replacing each other, in
the order global config, repository settings, `.sentryward.yaml`:

- A layer can add rules but never remove or override one from a layer before
  it. A rule whose id is already set is ignored, the earlier rule applies, and
  the review lists a warning (for example, a file rule reusing a workspace
  rule's id). A pull request can therefore not loosen workspace rules either.
- The limits (50 rules, 16000 characters of model-checked rule text) apply to
  the combined list. If a layer's rules would go past them, that layer's rules
  are all left out, with a warning, and the earlier layers still apply.
- Saving repository settings is refused when their rules clash with a global
  rule or would not fit beside the global rules. The global config lists, as
  warnings, repositories whose saved rules it leaves out.
- Dashboard rules (global config and repository settings) are held to the
  `severity_floor` and `min_confidence` the dashboard layers resolve to, profile
  included. A `.sentryward.yaml` or trigger can lower them for those rules but
  not raise them, so a repository cannot quiet workspace rules that way. Their
  patterns also run on files that only the file's `ignore_paths` leaves out;
  model-checked dashboard rules are not, since the model never sees ignored
  files.
- A repository that follows the global config uses the global rules and the
  file's rules, without its own saved ones.
- The effective config (`GET /api/repos/:id/config`) names each rule's layer as
  `sources["rules.<id>"]`.

The editor checks patterns with the server's RE2 as they are typed, since a
browser accepts lookarounds and backreferences that RE2 rejects. Dashboard rules
are not visible in the repository, so the inline comment for a rule finding
includes the rule's description and paths in a collapsed **📏 Rule** block.

### Static analysis findings

Sentryward does not run analyzers itself. With `review.tool_findings` on (the
default), it reads the results that already exist on the forge for the reviewed
commit and reports them next to the model's findings, marked with the
analyzer's name:

- **GitHub:** annotations of the head commit's finished check runs, such as
  linters run in Actions or CodeQL. This needs the Checks (read) permission.
  Checks still running when the review starts are left out, with a warning.
- **GitLab:** the Code Quality (`gl-code-quality-report.json`) and SAST
  (`gl-sast-report.json`) reports of the head commit's pipeline. GitLab's API
  only serves files from a job's artifacts archive, so list the report under
  `artifacts:paths` as well as `artifacts:reports`. Otherwise it is skipped with
  a warning.

How they are filtered:

- Only results on lines the change added are kept (or anywhere in a changed
  file, with `review.full_file`). They then pass the same category,
  `severity_floor`, dismissal and `max_findings` rules as model findings.
- Severity follows the analyzer's level: a GitHub failure is `major`, a warning
  `minor` and a notice `info`. A warning is filed under `maintainability`,
  which is not a default category, so linter warnings only appear when that
  category is enabled.
- When the model reported the same problem (same file and category,
  overlapping lines), the model's finding is kept.
- Tool findings never block unless `review.tool_findings_block` is on, because
  the analyzer's own check already passes or fails on the forge.
- If the results cannot be read (a missing permission, an unreachable report),
  the review continues with a warning.

## Privacy and data

Sentryward is self-hosted: review data stays in your PostgreSQL database, and
source code only leaves the server for the model endpoints and forges you
configure. This section lists what is kept and what is sent, and the controls
that limit both.

### What is stored

- **Reviews** (`review_jobs`): the change's title, the resolved configuration,
  the full review result (findings with their file, lines, explanation and
  suggested fix, the walkthrough, model usage and cost), the record of what was
  published, and a small summary digest. Diffs and file contents are not
  stored, only what the model said about them.
- **Findings** (`findings`): one row per finding per change, with its title,
  file and line, severity, model, the change's title and author, and its state,
  including ignore reasons and notes.
- **Posted comments** (`posted_findings`): which inline comments were posted
  where, so a later run does not repost them.
- **Thread replies** (`thread_replies`): replies and `/sentryward` commands left
  on Sentryward's inline threads, including the commenter's text.
- **Credentials**: forge tokens, GitHub App installations, LLM API keys and
  notification URLs, encrypted with `ENCRYPTION_KEY` (AES-256-GCM). Only the
  last four characters of a key are ever shown.
- **Model capabilities and prices** per workspace, users, memberships, invites
  and API tokens (only hashes of invite, reset and API tokens are kept).
- **The audit log** of outbound model requests (see [Audit log](#audit-log)).

### What leaves the server

- **To model providers**, for each review: the diff of the change, surrounding
  file context (for agentic reviews, also the files and code-search results the
  model asks for), the review instructions and the repository's review rules,
  linked and related issue text for the walkthrough, and dismissed findings
  used to steer the review. Thread answers send the finding, the code around it
  and the reply text. Capability probes and connection tests send a fixed
  one-line prompt. Model list requests (`/models`) send only the key.
- **To forges**: API reads of the change, files, issues and analyzer results,
  and the comments, statuses, labels and description updates Sentryward
  publishes.
- **Elsewhere**: only the notification targets you configure (webhooks, Slack,
  email), which receive the review summary.

### Retention

Review data is kept forever unless a retention period is set.

| Where | Who | Notes |
| --- | --- | --- |
| **Administration > Instance settings** | Instance admin | Takes precedence over the environment variable |
| `REVIEW_RETENTION_DAYS` | Operator | Applies when the instance setting is empty (unset, the default, keeps everything), so existing deployments keep their behaviour |
| **Privacy** page | Workspace admin | Can only shorten it: the shorter of the two applies |

Once an hour the worker:

- **Prunes reviews** older than the period, in batches of 500 rows so it never
  holds long locks:
  - Superseded, skipped and cancelled reviews that finished more than that many
    days ago are deleted.
  - Older completed, partial and failed ones have their stored result, resolved
    configuration and publication record cleared. Those keep their row, status,
    verdict and summary, so the reviews list, stats and findings list are
    unaffected, while the review page says the full result has expired and its
    markdown export answers `410`.
  - The newest completed or partial review of each change is never cleared,
    however old, so its findings keep their full details, replies on their
    inline threads can still be answered and the next push still gets an
    incremental review.
  - A finding last reported by an older, cleared review (for example one
    ignored a while ago) keeps its row but loses its full details.
  - Failed reviews that stored nothing are left as they are, so they still show
    their error.
  - Because cancelled reviews are deleted, a change cancelled or closed more
    than the window ago and later reopened at the same commit is reviewed
    again.
- **Purges inactive changes**: changes that have had no activity of any kind
  (reviews, findings seen, ignored or resolved, replies) for longer than the
  period have their findings, posted-comment records and finished thread
  replies deleted, and the result kept on their newest review is cleared.
  Review rows and summary digests stay, so usage, cost and the reviews list are
  unchanged. A change still under review is never purged, so findings do not
  lose their ignore state mid-review; if a purged change becomes active again it
  is reviewed afresh (the forge's own markers still stop inline comments from
  being posted twice), and benchmark and calibration figures no longer count
  its findings.
- **Deletes audit log entries** older than the instance's **audit log
  retention** (empty keeps them forever). Only instance admins set this, so a
  workspace cannot erase its own trail.

### Provider and host restrictions

Instance admins (Instance settings) and workspace admins (Privacy page) can
limit where model requests go:

- **Allowed providers**: the providers models may be named with (`anthropic`,
  `openai`, `google`, `ollama`). None selected allows all.
- **Allowed hosts**: where requests may be sent, such as `ollama.internal:11434`
  or `*.example.com` (any host below `example.com`, not the domain itself). A
  host without a port matches any port. Empty allows all. A model reached
  through an official API counts as that API's host (`api.anthropic.com`,
  `api.openai.com`, `generativelanguage.googleapis.com`).
- **Local only**: only endpoints whose host is `localhost` or resolves entirely
  to private or loopback addresses (for example a self-hosted Ollama, a Docker
  service name or `host.docker.internal`) may be called. Every official
  provider API is refused, including server-wide keys from the environment.

How the policy is enforced:

- A workspace can only narrow the instance: a model must pass both layers'
  lists, and local-only applies if either turns it on. Saving a workspace value
  the instance does not allow is refused.
- The policy is checked against every model a review may call, including
  fallbacks and models named in a repository's `.sentryward.yaml`, before
  anything is posted. A refused review, walkthrough or verify model fails the
  review with a message starting `Blocked by privacy policy:` that names the
  rule and the layer, and a refused fallback is skipped with a warning.
- Thread answers on a refused model post a short notice instead, without naming
  hosts.
- Saving, testing or listing models for an LLM connection the policy refuses is
  rejected before any request is made, and such a connection shows as
  **Blocked by policy**.
- The repository file cannot change these settings.

> [!NOTE]
> The local-only check resolves the host when the review starts. It protects
> against misconfiguration, not against an attacker who controls DNS (rebinding
> between the check and the request); for a hard guarantee, also block outbound
> traffic from the `worker` and `server` containers at the network level.

### Audit log

Every request sent to a model is recorded: time, workspace, repository and
change, purpose (review, walkthrough, verify, capability probe, thread reply,
connection test), provider, host, model, input/cached/output/reasoning tokens,
latency and outcome. A failed request records only a short error kind (such as
`http_429` or `unusable_reply`), never the error text, and prompts, code and
replies are never recorded. Entries keep the workspace and repository names
after those are deleted, until audit retention removes them.

Workspace admins see their workspace's log in the **Audit log** tab of the
**Privacy** page; instance admins see every workspace's in the **Audit log** tab
of **Administration > Instance settings**. Both can filter it and export it as
CSV or JSON (up to 100,000 rows per export; an `X-Truncated: true` header marks
a cut-off export). The endpoints, which API tokens can also read:

| Method | Path | Who |
| --- | --- | --- |
| `GET`/`PUT` | `/api/privacy` | Read: any member. Write: workspace admin |
| `GET` | `/api/privacy/audit-log`, `/api/privacy/audit-log/export?format=csv\|json` | Workspace admin |
| `GET`/`PUT` | `/api/admin/settings` | Instance admin |
| `GET` | `/api/admin/audit-log`, `/api/admin/audit-log/export?format=csv\|json` | Instance admin |

The audit log endpoints accept `provider`, `purpose`, `outcome`, `q` (searches
model, host, repository and workspace), `from` and `to`, plus `page` and `limit`
for the list and `workspaceId` for the instance-wide log.

## API

### API tokens

Scripts and CI authenticate with a personal API token instead of the browser
cookie. Create one under **Settings > API tokens**, with a name and an expiry
(7, 30, 90 or 365 days, or none). The value starts with `swt_` and is shown only
once, because only its hash is stored. Send it as a bearer token; it acts as the
user who created it, and the workspace header works as it does for the
dashboard:

```sh
curl -X POST https://sentryward.example.com/api/reviews \
  -H "Authorization: Bearer $SENTRYWARD_TOKEN" \
  -H "x-sentryward-workspace: <workspace id>" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/acme/api/pull/42"}'

curl https://sentryward.example.com/api/reviews/<review id>/markdown \
  -H "Authorization: Bearer $SENTRYWARD_TOKEN"
```

- **Allowed:** any `GET` request its user can make, plus `POST /api/reviews` and
  `POST /api/reviews/:id/rerun`. Every other write gets `403`, and tokens cannot
  manage tokens, so a leaked one can't change the account or create more
  tokens.
- **Session only:** the GitHub install and GitLab OAuth flows under
  `/api/connections` are `GET` but add connections, so they need a signed-in
  session too.
- **Errors:** a revoked, expired or unknown token gets `401`. If the
  `Authorization` header is present, the cookie is ignored.
- **Limits:** token requests count against the same per-user rate limit as the
  user's dashboard requests.
- **Lifetime:** tokens survive password changes and resets, including resets an
  admin issues; revoke them one by one in Settings. Deleting the account
  deletes its tokens.

### Endpoint reference

Endpoints that act on workspace data (connections, repositories, reviews,
findings, global config, LLM keys and notifications) read the workspace id from
the `x-sentryward-workspace` header. Without it they use the caller's personal
workspace, so scripts written before workspaces keep working. Routes under
`/api/workspaces/:id` name the workspace in the path instead.

Register, login, the registration mode, invite lookups and password resets are
rate limited (20 requests per 15 minutes per IP).

<details>
<summary>Auth</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST   | `/api/auth/register` | `{ name, email, password, confirmPassword, inviteToken? }`, sets the auth cookie; after the first account, `REGISTRATION_MODE=invite` requires an instance invite or a team invite whose original creator is currently an instance admin; other valid team invites return 403 |
| GET    | `/api/auth/registration` | `{ mode, firstUser, mailConfigured, passwordLogin, providers }`, so the register page can say whether it is usable, the forgot password page whether a reset can be emailed, and the login page which sign-in providers (`{ id, host }`) to offer |
| GET    | `/api/auth/oauth/:provider/start` | Browser navigation: `?intent=login` (default, with optional `invite`) or `?intent=link` (needs a session); redirects to the provider with a single-use state and PKCE, bound to this browser by a short-lived cookie. 404 for an unknown or unconfigured provider |
| GET    | `/api/auth/oauth/:provider/callback` | Where the provider returns. Signs in, creates the account or links the identity, then redirects to `/home` or `/settings?tab=sign-in`; failures redirect to `/login?error=<code>` (or the settings tab) |
| GET    | `/api/auth/invites/:token` | The invite's email, inviter and expiry, or 404 when invalid, used or expired |
| POST   | `/api/auth/invites/:token/accept` | Signed in: joins the team the invite is for and returns that workspace |
| POST   | `/api/auth/login` | `{ email, password }`, sets the auth cookie; an account without a password gets the same 401 as a wrong one. Login, register and the password reset endpoints return 403 when `PASSWORD_LOGIN=disabled` |
| POST   | `/api/auth/password-reset` | `{ email }`; emails a reset link when the account exists and mail is configured. Always `202 {}` |
| GET    | `/api/auth/password-reset/:token` | `{ email }` for a valid link, or 404 when invalid, used or expired |
| POST   | `/api/auth/password-reset/:token` | `{ password, confirmPassword }`; sets the password, ends other sessions, sets the auth cookie and returns the session |
| POST   | `/api/auth/logout` | Clears the auth cookie |
| GET    | `/api/auth/me` | Current user, or 401 |

</details>

<details>
<summary>Forge connections</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/connections` | The workspace's forge connections, which browser connect flows are configured, and the GitLab OAuth host |
| PUT    | `/api/connections/order` | Admins: `{ ids }`, every connection in the workspace in the order to list them; 409 if the set has changed. Connections added later are listed after |
| POST   | `/api/connections/gitlab` | `{ host?, token }`, validates the token against GitLab and stores it encrypted |
| GET    | `/api/connections/github/install?workspace=` | Session only: redirects to the GitHub App's install page; the installation is added to that workspace |
| GET    | `/api/connections/github/callback` | Session only: GitHub's return URL after installing the app |
| GET    | `/api/connections/gitlab/oauth/start?workspace=` | Session only: redirects to GitLab's OAuth authorize page with a single-use state (PKCE) |
| GET    | `/api/connections/gitlab/oauth/callback` | Session only: GitLab's OAuth redirect URI; validates the state, exchanges the code and stores the connection |
| DELETE | `/api/connections/:id` | Removes a connection and its repositories |

</details>

<details>
<summary>Repositories</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/repos?connectionId=` | Repositories the connection can see, by path, with their enabled flag and `position` (the Repositories tab's saved order, or null) |
| GET    | `/api/repos/last-reviews` | `{ lastReviews }`, each added repository's newest run that wasn't skipped or superseded, by repository id; repositories with none are left out |
| PUT    | `/api/repos/order` | Admins: `{ ids }`, every added repository in the workspace in the order to show them; 409 if the set has changed |
| POST   | `/api/repos` | `{ connectionId, externalId }`, enables a repository for review |
| PATCH  | `/api/repos/:id` | `{ enabled?, settings?, followGlobal? }`; `settings` replaces the saved review overrides, `followGlobal` makes the repository ignore them and use only the global config |
| GET    | `/api/repos/:id/config` | The effective review config for the default branch, where each value came from, and any repository-file warnings |

</details>

<details>
<summary>Reviews</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST   | `/api/reviews` | `{ url }` of a pull or merge request on an enabled repository; queues a review of its current head |
| GET    | `/api/reviews?repoId=&status=&page=&limit=` | The workspace's reviews, newest first, with a summary but not the full result; returns `{ reviews, total, page, limit }` (`limit` 1-100, default 20) |
| GET    | `/api/reviews/stats?repoId=&days=` | Runs, verdicts, review time and token totals over the last `days` (default 7), with `cost: { usd }` (see below) |
| GET    | `/api/reviews/attention` | `{ failed, since }`: runs that failed since the caller last opened the Reviews list in this workspace, or in the last 24 hours before their first visit |
| POST   | `/api/reviews/viewed` | Records that the caller opened the Reviews list in this workspace (204) |
| GET    | `/api/reviews/:id` | One review with its full result (see below) |
| GET    | `/api/reviews/:id/markdown` | The review as the markdown document that is posted to the forge |
| POST   | `/api/reviews/:id/rerun` | Queues a fresh review of the PR's latest head |
| POST   | `/api/reviews/:id/cancel` | Cancels a queued or running review; a running one stops within one check interval (about 15s) and posts nothing more. `409` once it has finished |

- `GET /api/reviews/stats`: `cost.usd` is the summed costs reviews recorded when
  they ran. Reviews from before costs were recorded add nothing.
- `GET /api/reviews/:id`: each model call carries the `cost` it recorded and
  `usageTotals.costUsd` sums them. While it runs, `progress` holds its current
  `stage`, the `steps` it will go through and, during review passes,
  `passes: { done, total }`.

</details>

<details>
<summary>Usage and benchmarks</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/usage?period=&repoId=` | Model usage of the workspace's reviews over `24h`, `7d` (default), `30d`, `90d` or `all` (see below) |
| GET    | `/api/usage/recent?period=&repoId=&page=&limit=` | `{ reviews, total, page }`: one page (`limit` 10 by default, 100 at most) of the period's reviews that called a model, newest first, with their models, tokens and cost; a page past the end returns the last one |
| GET    | `/api/benchmarks?period=&repoId=` | Model benchmarks over `24h`, `7d` (default), `30d`, `90d` or `all` (see below) |

- `GET /api/usage` returns totals with input, cached and output tokens and the
  cost, a UTC time series (hourly for `24h`, monthly for a long `all`), and
  breakdowns by model (input, cached and output cost each), provider and
  repository.
- `GET /api/benchmarks` returns:
  - `totals`;
  - `byModel`: reviews, tokens, `cost: { usd, partial, perReview }` with `usd`
    null when no call had a price, `meanLatencyMs`, `findings`;
  - `byRepository`: adds `medianDurationMs` and `duplicates: { count, rate }`;
  - `byLanguage` / `byCategory`: rows `{ key, findings, models, best }`.

  `findings` is `{ found, confirmed, falsePositives, confirmedRate,
  falsePositiveRate }` over findings first seen in the period.

</details>

<details>
<summary>Findings</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/findings/stats?repoId=&days=` | Open findings by severity, resolution rate, median time to resolve (invalidated findings count as neither) and the false-positive rate over the last `days` (1-365, default 30) (see below) |
| GET    | `/api/findings/calibration?repoId=&days=&groupBy=` | How the confidence models self-report has matched outcomes over the last `days` (see below) |

- `GET /api/findings/stats`: `falsePositivesBy` breaks the false-positive rate
  down by `category` (unknown stored categories as `other`), `severity` and
  `model` (the model whose review pass raised each finding, `null` for tool and
  rule findings and rows with no recorded model), each row
  `{ key, found, falsePositives, rate }`.
- `GET /api/findings/calibration`: findings are bucketed by reported confidence
  in tenths, each bucket
  `{ min, max, found, confirmed, falsePositives, decided, confirmedRate, falsePositiveRate }`
  where confirmed means fixed, false positive means dismissed as one, and the
  rates are over `decided` (the two together). `groupBy` is `none` (default, one
  group), `model` or `category`. Tool and rule findings carry no self-reported
  confidence and are left out. The response sets `selfReported: true`:
  confidence is never a calibrated probability by itself.

</details>

<details>
<summary>Webhooks</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST   | `/api/webhooks/github` | GitHub App webhook (signed with `GITHUB_WEBHOOK_SECRET`) |
| POST   | `/api/webhooks/gitlab/:repoId` | GitLab project hook Sentryward registers per repository (token checked per repository) |

</details>

<details>
<summary>Review config</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/config/schema` | Defaults, profiles, severities and categories for the settings UI, plus the context window per provider (`contextWindows`, `defaultContextWindow`) and `thinkingBudgets` an `auto` context budget is resolved from |
| GET    | `/api/config/global` | The workspace's global review config, and what it resolves to with each value's source |
| PUT    | `/api/config/global` | Workspace admins: `{ settings }`, replaces the global review config; `{}` resets it |
| POST   | `/api/config/rules/check` | `{ patterns }` (up to 50, 300 characters each): `{ errors }`, one per pattern in order, `null` when RE2 compiles it, otherwise the message a save would give |
| POST   | `/api/config/triggers/check` | Whether a sample change would be reviewed under these trigger settings, from the worker's own skip rules (see below) |

- `POST /api/config/triggers/check` takes `{ base, settings, event, change, actor? }`.
  `event` is `opened`, `push` or `command`; `change` is
  `{ title, author, labels, headRef, baseRef, isDraft }`. Returns
  `{ reason, fullReview, walkthrough }`, `reason` being the skip reason or
  `null`. The repository's `.sentryward.yaml` is not part of it.

</details>

<details>
<summary>LLM connections and model prices</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/settings/api-keys` | Every LLM provider, with whether the workspace stored a credential, its key's last four characters, its custom host, whether the server has a key of its own and whether the privacy policy blocks the provider or host (`blocked`) |
| PUT    | `/api/settings/api-keys/:provider` | Workspace admins: `{ apiKey?, baseUrl? }`, verifies the credential with the provider and stores the key encrypted |
| DELETE | `/api/settings/api-keys/:provider` | Workspace admins: removes the stored credential |
| GET    | `/api/settings/api-keys/:provider/status` | `{ status }`: `active`, `revoked` when the provider rejects the key, or `unreachable` |
| GET    | `/api/settings/api-keys/:provider/models` | The model ids the connection lists, prefixed with its provider; 400 when the host rejects the key or is down |
| POST   | `/api/settings/api-keys/:provider/test` | `{ model }`, runs one minimal generation with the stored credential (see below) |
| GET    | `/api/settings/api-keys/:provider/capabilities` | `{ capabilities }` per model reached through the connection (see below) |
| GET    | `/api/settings/model-prices` | `{ prices, models }`: the workspace's own model prices and the models its reviews called (see below) |
| GET    | `/api/settings/model-prices/lookup?model=` | `{ model, price, builtIn }`: the price a review of `model` gets now (workspace prices included) and its built-in price; `null` when unknown |
| PUT    | `/api/settings/model-prices` | Workspace admins: `{ model, input, output, cached?, cacheWrite?, reasoning? }`, saves (or replaces) the price for `model`; applies to reviews from then on |
| DELETE | `/api/settings/model-prices/:id` | Workspace admins: removes a price |

- `POST .../test` returns `{ result }` with latency and token usage, or
  `ok: false` with a `reason` (`revoked`, `model`, `unreachable`, `output`) and
  message. A passing test also probes the model and adds
  `capabilities: { thinking, tools, detail }`, which it stores. 400 when an
  official API is given another provider's model; 409 when the stored key can't
  be decrypted.
- `GET .../capabilities`: each entry is
  `{ model, endpoint, thinking, tools, source, detail, checkedAt }`, where
  `thinking` is `options`, `model`, `none` or `null` (unknown), `tools` is a
  boolean or `null`, and `source` is `probe` or `runtime`. Saving or removing
  the connection clears them.
- `GET /api/settings/model-prices`: `prices` are `{ id, model, price, updatedAt }`
  (USD per million tokens); `models` are those its reviews called in the last 90
  days with their built-in price and the price reviews get now, workspace prices
  included (`builtIn`, `price`; `null` when unknown).

</details>

<details>
<summary>Notifications</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/notifications` | `{ targets, mailConfigured, settings }`: the workspace's notification targets with their events, whether each is `active`, `pausedReason` (set when the worker auto-paused it), `pauseCause` (`gone`, `failures`, `scope` or `null`), the scope (`repositoryIds`, empty for all; `minSeverity`, `minor`, `major`, `critical` or `null`; `onlyVerdictChanges`), `secretRotatedUntil` (a webhook's previous secret still signs until then, else `null`), `delivery` (`{ mode, hour, weekday, timeZone, nextDigestAt, held }`: `mode` `each`, `daily` or `weekly`, the schedule (kept after switching back to `each`), when the next digest is built (`null` for `each`) and how many reviews it holds), `consecutiveFailures`, a URL's host only, email recipients' user ids, `lastDelivery` (`{ status, event, httpStatus, error, attempts, nextAttemptAt, createdAt }` or `null`) and `pending` (`{ count, retry }`: how many deliveries are queued, and the retry due soonest as `{ attempts, httpStatus, error, nextAttemptAt }` or `null`); `settings` is `{ autoPauseAfter }` |
| GET    | `/api/notifications/:id/deliveries` | `?page&limit` (default 20, max 100): `{ deliveries, total, page, limit }`, the target's delivery log newest first (`event`, including `test` and `digest`, `status` `pending`, `sent` or `failed`, `httpStatus`, `error`, `attempts`, `nextAttemptAt`, `jobId`, `createdAt`, `finishedAt`, null while pending); members can read it |
| PATCH  | `/api/notifications/settings` | Workspace admins: `{ autoPauseAfter }`, 0 to 50 failed deliveries in a row before a target is paused (0 never); returns `{ settings }` |
| POST   | `/api/notifications` | Workspace admins: `{ kind: "webhook" \| "slack", name, events, url }` or `{ kind: "email", name, events, recipientIds }`, each optionally with `repositoryIds` (repositories of the workspace, default all), `minSeverity`, `onlyVerdictChanges` and `delivery` (`{ mode: "each" }`, the default, `{ mode: "daily", hour, timeZone }` or `{ mode: "weekly", hour, weekday, timeZone }`, `hour` 0-23, `weekday` 0-6 from Sunday, `timeZone` an IANA name); events are `failed`, `blocked`, `resolved` and `completed`; returns `{ target, secret? }`, a webhook's signing secret shown only here |
| PATCH  | `/api/notifications/:id` | Workspace admins: `{ name?, url?, events?, recipientIds?, repositoryIds?, minSeverity?, onlyVerdictChanges?, delivery?, active? }`; a new digest schedule counts from now (held reviews carry over), and `delivery: { mode: "each" }` on a digest target sends what it held as a final digest; `active: false` pauses deliveries and drops the ones queued, and any `active` clears `pausedReason` and the failure count. A target paused because its repositories were removed keeps that reason, and refuses `active: true` (400 on `repositoryIds`), until `repositoryIds` is sent. `url` (webhook and Slack only, 400 on `url` for email) is checked like a new target's and keeps the secret |
| POST   | `/api/notifications/:id/rotate-secret` | Workspace admins, webhooks only: returns `{ target, secret }`, the new signing secret shown only here; the previous one also signs deliveries for 24 hours |
| GET    | `/api/notifications/personal` | Any member: `{ enabled, events, pausedReason, forges, mailConfigured }`, the member's own email about reviews of changes they opened; `forges` is `[{ provider, host, linked }]` for each forge host of the workspace, `linked` when the member has a sign-in identity there |
| PUT    | `/api/notifications/personal` | Any member: `{ enabled, events }` (at least one event); `enabled: true` needs mail configured (400). Saving clears an auto-pause; switching off drops what is queued. Returns the same shape as GET |
| POST   | `/api/notifications/:id/test` | Workspace admins: sends a sample delivery; returns `{ result }`, `{ ok: true }` or `{ ok: false, error }` |
| DELETE | `/api/notifications/:id` | Workspace admins: removes a target |

</details>

<details>
<summary>Account, avatars and API tokens</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| PUT    | `/api/settings/avatar` | Raw PNG, JPEG or WebP body (512 KB at most; the dashboard uploads a 256px JPEG); sets the caller's profile picture |
| DELETE | `/api/settings/avatar` | Removes the caller's profile picture, so their initials show again |
| GET    | `/api/users/:id/avatar` | A user's profile picture, for any signed-in user; 404 when they have none |
| GET    | `/api/settings/tokens` | Session only: the caller's API tokens with name, creation, last use and expiry; never the values |
| POST   | `/api/settings/tokens` | Session only: `{ name, expiresInDays }` (1-365, or `null` for no expiry); returns `{ token, value }`, the value shown only here |
| DELETE | `/api/settings/tokens/:id` | Session only: revokes one of the caller's tokens |
| GET    | `/api/settings/identities` | Session only: the caller's linked sign-in accounts, `{ id, provider, host, email, createdAt }` |
| DELETE | `/api/settings/identities/:id` | Session only: unlinks one; 409 when it is the caller's last way to sign in |

</details>

<details>
<summary>Instance admin</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/admin/users` | Admin only: every user with their role |
| PATCH  | `/api/admin/users/:id` | Admin only: `{ role: "admin" \| "member" }`; refuses to remove the last admin |
| DELETE | `/api/admin/users/:id` | Admin only: deletes another user and everything they own |
| POST   | `/api/admin/users/:id/password-reset` | Admin only: returns `{ link, expiresAt }`, a single-use reset link shown only here |
| GET    | `/api/admin/invites` | Admin only: pending invites |
| POST   | `/api/admin/invites` | Admin only: `{ email? }`; returns `{ invite, link, emailed }`, the link is shown only here |
| POST   | `/api/admin/invites/:id/resend` | Admin only: emails a new link for an email invite and renews its expiry; needs SMTP |
| DELETE | `/api/admin/invites/:id` | Admin only: revokes a pending invite |

Privacy, instance settings and audit log endpoints are listed under
[Audit log](#audit-log).

</details>

<details>
<summary>Workspaces</summary>

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET    | `/api/workspaces` | The caller's workspaces with their role in each |
| POST   | `/api/workspaces` | `{ name }`, creates a team workspace owned by the caller |
| PATCH  | `/api/workspaces/:id` | Owners: `{ name }`, renames a team |
| DELETE | `/api/workspaces/:id` | Owners: deletes a team and everything in it, removing Sentryward's forge hooks first |
| GET    | `/api/workspaces/:id/members` | Members with their role and join date; response includes `allowDirectMemberAdd` |
| POST   | `/api/workspaces/:id/members` | Team admins: `{ email, role? }`; exact email creates `201 { invite, link, emailed }` requiring acceptance by default; when `allowDirectMemberAdd` is enabled, adds an existing account immediately and returns `201 { member }` |
| GET    | `/api/workspaces/:id/member-candidates` | Team admins: accounts not yet in the team, only when `allowDirectMemberAdd` is enabled; otherwise 403 |
| PATCH  | `/api/workspaces/:id/members/:userId` | Team admins: `{ role }`; only owners grant or revoke `owner`, and the last owner cannot be demoted |
| DELETE | `/api/workspaces/:id/members/:userId` | Team admins remove a member; any member may remove themselves to leave |
| GET    | `/api/workspaces/:id/invites` | Team admins: pending team invites |
| POST   | `/api/workspaces/:id/invites` | Team admins: `{ email?, role? }`; returns `{ invite, link, emailed }` like an instance invite |
| POST   | `/api/workspaces/:id/invites/:inviteId/resend` | Team admins: emails a new link for an email invite and renews its expiry |
| DELETE | `/api/workspaces/:id/invites/:inviteId` | Team admins: revokes a pending team invite |

</details>

## Development

| Layer    | Tech |
| -------- | ---- |
| Client   | Vite, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, React Router, TanStack Query, react-hook-form + zod |
| API      | Express 5, TypeScript (run with tsx), Prisma 7 (`@prisma/adapter-pg`), zod, argon2id, JWT in an httpOnly cookie |
| Database | PostgreSQL 17 |

### Tests

```sh
docker compose exec server npm test   # API tests against the sentryward_test database
docker compose exec client npm test   # React component and routing tests
```

GitHub Actions also runs type checks, client lint, and the client production
build inside Docker. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete
checks.

### Review quality evals

The tests use a fake model, so they say nothing about how good the reviews are.
`server/evals/` holds a corpus of small changes with the findings a good review
should report, and a script that reviews each one with a real model and scores
the result. Use it to tell whether a change to prompts, chunking, context or
validation helps.

> [!WARNING]
> Evals call the provider's API and cost money, so they are not part of
> `npm test` or CI.

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

**How cases are scored.** Each case runs through `runReview` with the default
configuration, so it measures what production would report. A finding matches
an expected finding when it is in the same file and its lines overlap the
expected range (within the tolerance); each expectation is credited once. The
script prints a table and writes a JSON report with per-case findings, misses,
false positives (and which of them hit a known trap), token use and cost, plus
precision, recall and F1 over the whole corpus. A review that fails outright is
reported as errored and left out of the rates. Set `EVAL_GIT_SHA` to record the
commit, since the container has no git.

**Adding a case.** Create `server/evals/cases/<id>/` with:

- `before/` and `after/`: the files the change touches, before and after.
  `after/` also serves as the head revision for review context, so include
  files the reviewer would need to read.
- `diff.patch`: generate it on the host with
  `sh server/evals/make-patch.sh server/evals/cases/<id>`.
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
starts on an added line (a finding on an unchanged line is moved to the nearest
added one), without calling a model. CodeQL scans the fixtures too, so a
deliberately vulnerable case can raise an alert on its PR; dismiss it as "used
in tests".

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

<details>
<summary>Why PostgreSQL over MySQL</summary>

- Real `UUID`, `TIMESTAMPTZ` and `CITEXT` types (emails are case-insensitive at
  the database level).
- `JSONB`, arrays, full-text search and row-level security for future cloud
  features.
- Transactional DDL, so a failed migration rolls back cleanly.

</details>

## Contributing and license

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md), and look for
[good first issues](https://github.com/rdlugs/sentryward/labels/good%20first%20issue).
Questions and ideas go to [Discussions](https://github.com/rdlugs/sentryward/discussions).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
which also covers deployment boundaries and how credentials are stored.
Release notes are in the [changelog](CHANGELOG.md).

Licensed under [MIT](LICENSE), with [third-party notices](THIRD_PARTY_NOTICES.md).
