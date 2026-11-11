# Changelog

All notable changes to Sentryward are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Sentryward is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Added

- Personal notifications (#258). Any member can switch on email about reviews
  of the pull and merge requests they opened, from a **Your pull requests**
  card on the Notifications page (`GET`/`PUT /api/notifications/personal`),
  choosing blocked, failed, resolved and completed. A change is matched to a
  member through the forge user id of its author, recorded on the review job
  (`author_id`) when the worker fetches the change, against a GitHub or
  GitLab sign-in identity the member linked on the same host; the card points
  to Sign-in methods for any host without one. Personal targets go through
  the same outbox, are hidden from the workspace's targets and from admins,
  are deleted when the member leaves the workspace, and are skipped for a
  review a workspace email target already sends that member. Reviews where
  the member is a requested reviewer are not covered yet.
- Notification URLs can be edited and webhook secrets rotated in place
  (#257). `PATCH /api/notifications/:id` accepts `url` for webhook and Slack
  targets, checked like a new target's, keeping events, scope, secret and
  history; the edit panel has a URL field showing the current host. `POST
  /api/notifications/:id/rotate-secret` (admins, webhooks) returns a new
  secret once, from **Rotate secret** in the target's menu. For 24 hours the
  previous secret keeps signing too: `X-Sentryward-Signature-V2` and
  `X-Sentryward-Signature` carry `sha256=<new>,sha256=<old>`, so receivers
  should accept any listed value (the README's verification example does).
  Targets report `secretRotatedUntil`.
- Webhook deliveries carry a delivery id, a signed timestamp, the head commit
  and the trigger (#256). The body gains `deliveryId` (the same on every retry
  of a delivery, so a receiver can tell a retry from a new one) and
  `timestamp` (ISO 8601, set at each send to the same second as the
  timestamp header; neither key can be replaced by the payload), and each
  review gains
  `change.headSha` and `review.trigger` (rows queued before the upgrade lack
  them). New headers: `X-Sentryward-Delivery`, `X-Sentryward-Timestamp` (unix
  seconds) and `X-Sentryward-Signature-V2: sha256=<hex>`, the HMAC-SHA256 of
  `<timestamp>.<body>`, so a receiver can reject a delivery older than a few
  minutes instead of accepting a captured one forever. A test delivery's
  `deliveryId` is the id of its row in the delivery log.
- Daily and weekly notification digests (#253). Each target chooses **Each
  review** (the default) or a daily or weekly digest at an hour (and weekday)
  in its own IANA timezone, DST included. A digest target holds the reviews
  that pass its events and scope as `held` outbox rows, and the worker rolls
  them into one `digest` delivery when due: counts by verdict, failed and
  resolved reviews, the five most-blocked repositories, the still-blocked
  changes with links (a change whose newer review passed is left out, even
  if the target did not hold that review), and the failed reviews (reviews
  capped at 200 and blocked changes at 50, with `truncated` and
  `blockedTruncated` counting the rest; counts cover all; up to 50 of the
  review places are kept for failed reviews so blocked ones cannot crowd them
  out). Empty periods send nothing; each digest is queued once under a
  row lock, and a worker that was down catches up on its next poll. A
  digest that fails to build is retried an hour later without stalling other
  targets (the retry only moves a schedule nobody changed in the meantime),
  held rows are read in pages and the still-blocked changes are worked out in
  the database, so a busy period's digest stays bounded in memory, and an
  unknown stored timezone falls
  back to UTC. Webhooks
  get `event: "digest"` with the list, Slack one summary message, email a
  plain-text summary. Pausing drops held reviews; switching back to each
  review sends them as a final digest. Held reviews stay out of the delivery
  log and the fixed delivery retention, but a workspace's shorter privacy
  retention deletes them. The add and edit panels gain a **Delivery** section, and
  the list shows the schedule under the target's name. `POST`/`PATCH
  /api/notifications` accept, and `GET` returns, `delivery` (migration
  applied on start).
- Notification targets can be limited by repository and minimum severity
  (#251). A target hears about all repositories (the default) or only the ones
  chosen, and about every review (the default) or only those with at least
  one minor, major or critical finding; failed and resolved reviews ignore the
  severity floor. Repository ids are checked against the workspace. Deleting a
  repository, or its connection, removes it from every target, and a target
  left with none is paused ("Paused: its repositories were removed",
  `pauseCause: "scope"`) instead of widening to every repository; it can only
  be switched back on after its repositories (or All) are saved, so the
  Failing targets tab offers no Resume for it and its switch stays off. The add and
  edit panels gain a **Scope** section, and the list shows the scope under the
  target's name (e.g. "acme/payments · ≥ major"). `POST`/`PATCH
  /api/notifications` accept, and `GET` returns, `repositoryIds`,
  `minSeverity` and `onlyVerdictChanges` (migration applied on start).
- **Only when the verdict changes** per target, and a new **Resolved** event
  (#252). With the option on, blocked and completed deliveries are sent only
  when the verdict differs from the previous completed or partial review of
  the same pull or merge request (the first review always counts; failed runs
  in between are passed over), however either review was triggered.
  `resolved` fires when a review passes after the previous one was blocked (a
  partial review with no blocking findings does not count); it
  ranks after `blocked` and before `completed`, can be the webhook `event`,
  reads "Blocking issues resolved" in Slack and email, and, like `failed`,
  ignores the severity and verdict filters.
- Notification deliveries are retried (#249). A finished review's deliveries
  are queued as pending rows in the same step that marks it notified, so a
  worker restart no longer loses them, and the worker sends them outside the
  review slots, so a slow endpoint no longer delays reviews. The worker also
  queues them for any review finished in the last 24 hours that a stopped
  worker never got to. Timeouts,
  connection errors, `408`, `429` (honouring `Retry-After`) and `5xx` are
  retried up to 5 tries with 1m/5m/30m/2h backoff; other failures are final.
  The delivery log shows pending deliveries ("Queued", "Retrying · 503") with
  the next try, and deliveries gain `nextAttemptAt`. Pausing a target, by an
  admin or automatically, drops its queued deliveries, so resuming it never
  sends them.
- Notification targets pause themselves after repeated failures (#250): after
  the workspace's **Auto-pause after** limit of deliveries in a row fail for
  good (5 by default, 0 for never, set on the Notifications page's new
  **Failing targets** tab and `PATCH /api/notifications/settings`), or at once
  on `410 Gone` or Slack's `404`. That tab lists the targets that are paused,
  failing or retrying with a status, their failures in a row against the
  limit, the last error and next try, a hint on how to fix them, and **Send
  test** and **Resume** buttons (a passing test offers to resume); it stacks as
  cards on a phone. The reason shows on the row and in the edit dialog, owners
  and admins
  are emailed once when mail is configured (linking to the tab), and resuming
  the target clears it. `GET /api/notifications` adds `pauseCause`. A successful delivery resets the count. Adds outbox and failure
  columns to `notification_deliveries`, `notification_targets` and
  `workspaces` (migration applied on start). `GET /api/notifications` also
  returns each target's `pending` deliveries (`{ count, retry }`), so a target
  stays under Retrying, and the list keeps refreshing, while an older delivery
  is retried behind a newer one that went through.
- A delivery log for notification targets (#248). Every delivery, tests
  included, is recorded with its outcome and the HTTP status or error (with the
  target URL cut out). The Notifications list has a **Last delivery** column,
  and **View deliveries** in a target's menu, open to admins and members, shows
  its history. `GET /api/notifications` returns each target's `lastDelivery`,
  and `GET /api/notifications/:id/deliveries` pages the log. The worker keeps
  the last 30 days, at most 100 deliveries per target. Adds the
  `notification_deliveries` table (migration applied on start).
- Output settings for how much a review posts (#246), each set from the Display
  tab or `.sentryward.yaml`, defaulting to today's behaviour:
  `output.inline_min_severity` posts inline comments only at or above a
  severity, `output.max_inline_comments` caps inline comments on the change (the
  most severe first, threads from earlier runs included), and findings either one holds back are written out in
  full in the summary under "Not posted inline".
  `output.summary_only_with_findings` starts no summary comment for a completed
  review with no findings, while still updating one an earlier run posted; the
  commit status still reports the verdict.
- Sign up and log in with a GitHub or GitLab account (gitlab.com or
  self-managed), alongside email and password (#230). Each provider appears on
  the login and register pages once its `GITHUB_LOGIN_*` or `GITLAB_LOGIN_*`
  client id and secret are set; these are separate OAuth apps from the forge
  connections and only ask for identity scopes. A first sign-in follows the
  same registration rules as a password sign-up, including invites. Existing
  accounts are never linked by matching email: link a provider under
  Settings > Sign-in methods, where linked accounts can also be removed.
- `PASSWORD_LOGIN=disabled` turns off email and password sign-in, sign-up and
  resets, leaving only the configured providers (#230).
- Accounts created through a provider can set a password in Settings, and
  confirm deleting themselves by typing their email (#230).
- Display presets (Minimal, Standard, Everything) at the top of the Display tab
  set all of its switches at once, unsaved until you save, leaving fields the
  repository file sets alone (#245).
- The Display tab warns when Sentryward would post nothing to the PR/MR (#237),
  notes that the PR summary is still posted on its own while the summary
  comment is off (#242), and says which setting turns a greyed-out switch on
  (#235).
- Each optional part of the PR summary is tagged with what it adds to the model
  call (#243), and the high-level summary instructions have a character counter
  and insertable examples (#244).
- The Display preview switches to the view a changed setting shows up in (#239)
  and highlights only what the change did: what it takes out is marked first,
  then what it adds.

### Upgrade notes

- The `sign_in_identities` migration makes `users.password_hash` nullable and
  adds the `user_identities` and `sign_in_states` tables; it runs on start.
- Before setting `PASSWORD_LOGIN=disabled`, link a provider to admin accounts:
  accounts that only have a password cannot sign in while it is disabled, and
  the server refuses to start unless at least one provider is configured.
- The new output defaults apply to every workspace and repository that has not
  set these switches itself. If branch protection requires the
  `sentryward/review` status, turn on Post commit status (`output.post_check`)
  in the global config or the repository settings before upgrading, or merges
  wait for a status that is no longer posted.

### Changed

- Slack notifications for a review are richer (#254): an emoji per event in
  the headline ("🔴 Review blocked · acme/api #42"), the findings broken down
  by severity in `critical`/`major`/`minor`/`info` order, a failed review's
  error in a context block, and **View review** and **Open PR** (or **Open
  MR**) links, the latter only when the change URL is http(s) and short
  enough for Slack (characters that would end a mrkdwn link are encoded). The
  fallback `text` is unchanged, and forge text still only goes into
  plain-text objects; mrkdwn carries only these links.
- Email notifications for a review are sent as text and HTML (#255): the
  headline, repository and number, title, the findings by severity or the
  error, **View review** and **Open pull request** links, and a footer naming
  the target. Every forge value is HTML-escaped, a very long title or error
  is clipped (and the subject kept to 200 characters), and only an http(s)
  change URL is linked. `Mail` (`lib/mailer.ts`) gains an optional `html`.
  Digest emails stay plain text.
- A change URL that is not http(s) is now `null` in every notification
  payload, webhook bodies included, and digest emails link the review instead
  of such a URL (#254, #255).
- The comment posted while a review runs is now a status card: a thin
  animated progress bar (`client/public/sentryward-progress.svg`, which follows
  light/dark mode and stops moving under reduced motion), "Review in progress"
  with the commit, the change's scope (files, lines added and removed), what the
  review will publish, and a "View live progress" link to the dashboard. The
  bar is served from `main`, so it shows once this is merged there. A cancelled
  review's note uses the same card.
- Adding and editing a notification target opens a side panel instead of a
  dialog, so the longer form scrolls with its Cancel and Save buttons in view.
- The Failing targets tab groups each row's actions (View deliveries, Send
  test, Resume) in a "..." menu, matching the Targets tab.
- The output defaults are now a quiet setup, which the Display tab offers as its
  Standard preset: inline comments, one summary comment and a short PR summary
  with related issues and the blast radius. The commit status, finding counts,
  changes since the last review, review details, the labels segment, the effort
  estimate, sequence diagrams, linked issue assessment and the high-level
  summary are now off by default; each is still one switch away.
- The dashboard calls the walkthrough the PR summary everywhere (#233); config
  keys and `.sentryward.yaml` names are unchanged.
- The Display tab nests each switch under the one it depends on (#234), groups
  the effort and blast radius text with their native labels (#236) and puts the
  three post switches under "Where to post" (#237).
- The Display preview picks the forge and view with one click (#238), scrolls
  inside its pinned card (#240), takes less width from the settings (#241) and
  can be hidden, remembered per browser.
- Pushing a release tag now publishes the GitHub release automatically from
  the tag's changelog section, after the multi-arch image is pushed to GHCR.
  Stable tags are marked Latest; pre-release tags are marked as pre-releases.

### Deprecated

- The body-only `X-Sentryward-Signature` webhook header (#256). It is still
  sent alongside `X-Sentryward-Signature-V2` for this release and will be
  removed in the next minor release; switch receivers to the timestamped
  signature.

### Fixed

- The Recent reviews lists on the Home and Usage pages label an untitled
  GitLab merge request as `Merge request !42` and an untitled GitHub pull
  request as `Pull request #42`, instead of `#42`, and the Usage list writes a
  GitLab change as `group/project !42` instead of `group/project #42` (#269).
- The stats line at the end of the summary comment and of the review markdown
  now reads "2 review passes" instead of "2 review passs" when a review ran
  more than one pass (#260).
- `GET /api/reviews` answers `400 Validation failed` instead of
  `500 Internal server error` when the `number` filter is above 2147483647,
  the largest change number the database can store (#261). Starting a review
  by repository and number, or from a pasted URL, with a larger number is
  rejected with a 400 too, and searching for `#1234567890` now matches
  ten-digit change numbers.
- The paginated list endpoints (reviews, findings, usage, privacy and admin)
  answer `400 Validation failed` instead of `500 Internal server error` when
  `page` is above 1000000.
- Day counts read "1 day" instead of "1 days" (#271): the retention policy
  summary, the hints and instance-limit error in the privacy settings
  (including the error the API returns), and the "last N days" periods on the
  home page, the reviews and findings stats, the false positive breakdown and
  the confidence calibration.

### Security

- Slack notifications put the change title, the repository path and a failed
  review's error in plain-text blocks, so a pull request title can no longer
  ping the channel, render a link (bracketed or bare) or change the message's
  formatting. Newlines in these values are collapsed in Slack messages and
  email subjects (#247).

## [0.4.0] - 2026-11-07

Sentryward remains pre-1.0, and this release changes some default behaviour:
adding someone to a team now sends them an invitation to accept, and
invite-only registration accepts fewer team invites. AI findings still need
human verification.

### Upgrade notes

- Back up the database and `ENCRYPTION_KEY` before upgrading. The server
  applies this release's migrations on start.
- Adding a team member by email now creates an invitation the recipient must
  accept, and the add-member account picker is hidden. To restore immediate
  additions, an instance admin turns on **Allow direct member additions**
  under Administration > Instance settings > Policy. It is off on upgraded
  installations too; existing memberships are unaffected.
  `GET /api/workspaces/:id/member-candidates` answers 403 while it is off, and
  `POST /api/workspaces/:id/members` returns `{ invite, link, emailed }`
  instead of `{ member }`.
- In invite-only mode, a team invite only creates new accounts when its
  creator is currently an instance admin. Reissue other outstanding invites
  from an admin, or use an instance invite.
- `WORKER_SHUTDOWN_DRAIN_MS` (default 10 minutes) sets how long a stopping
  worker waits for in-flight reviews before handing them back to the queue.
  Keep `WORKER_STOP_GRACE_PERIOD` a few minutes above it (the defaults, 10m
  and 15m, already are), or Compose kills the worker before the hand-back.

### Added

- The LLM Config tab shows what was detected for the model that will run the
  review (thinking and tool support), and a Test model button runs it on that
  connection without saving. Connections whose key was rejected, could not be
  verified, or are blocked are marked in the connection picker (#190).
- Fallback models can be moved up and down (#191).
- The LLM Config tab shows the model's price, with a link to set one when it is
  unknown, and what an `auto` context budget resolves to for the model, max
  output tokens and thinking level, warning when a typed budget leaves no room
  for the reply. `GET /api/config/schema` now also returns the context windows
  and thinking budgets, and `GET /api/settings/model-prices/lookup?model=`
  returns the price a review of any model gets (#192).
- The Triggers tab can check a sample change, under a Will this be reviewed?
  toggle that starts closed: an event, title, author, labels,
  branches and draft state are run through the worker's own skip rules with
  the unsaved settings, and it answers Reviewed (with or without the PR
  summary, every file or new commits only) or the reason it would be skipped.
  It is served by the new `POST /api/config/triggers/check`.
- The header links to the GitHub repository beside the theme picker.

### Changed

- The verification model and verification thinking are greyed out while
  Verify findings is off, and the walkthrough model while the walkthrough is
  off, with a link to the tab that turns them on. Saved values are kept (#193).
- LLM Config tab polish: effective values are only shown when they come from
  somewhere other than the scope being edited, Profile sits above the tabs
  since it applies to all of them, Connection capabilities overrides are under
  an Advanced disclosure (kept open while one is set), Reset to defaults
  explains what it keeps and why it may be disabled, and the Model,
  Temperature, Max output tokens and Context budget descriptions match what
  the server does (#194).
- The Finding Types tab is regrouped into Severity, What gets reported,
  Accuracy, Scope and context, Static analysis and Fixes, with a summary panel
  beside it showing what a review reports and blocks on, unsaved edits
  included. A severity scale labels each severity as blocking, reported or
  hidden, and warns when the block level sits under the report level (those
  findings are dropped before they can block). Caller depth is greyed out
  while Surrounding code is off, and the agent limits unless Review context is
  Agentic. Categories have descriptions, a count and All/None buttons, and Min
  confidence has a slider. On every tab, a field's effective value now sits
  beside its label and the "leave empty" hint moved behind an info icon.
- The Triggers tab is regrouped into Automatic reviews, PR summary, Commands
  and replies, and Skip rules (by change, people and branches), with a summary
  panel of when Sentryward runs, unsaved edits included. While automatic
  reviews are Manual only, the push switches, the PR summary trigger and the
  skip rules are greyed out, since the worker never reaches them; the PR
  summary trigger is also greyed out while the walkthrough is off, with a link
  to the Display tab. Each skip list is tagged with how it matches, the review
  trigger spells out what happens to drafts, and a repository's list says it
  replaces the inherited one.
- Team membership requires consent. Adding someone by email creates an
  email-bound invitation (emailed when SMTP is configured, otherwise a link to
  copy), and access begins only when they accept. Team admins no longer see
  which emails have accounts, unless an instance admin turns on Allow direct
  member additions, which brings back the account picker and immediate
  additions (#206).
- Stopping or upgrading the worker no longer leaves unfinished reviews waiting
  for stale-lock recovery. The worker waits up to `WORKER_SHUTDOWN_DRAIN_MS`
  for in-flight reviews, then puts any still running back in the queue without
  using one of their attempts, so the new worker picks them up about half a
  minute later. Each handed-back review stays leased until any forge call the
  old worker had in flight has finished, so it cannot be run twice (#212).

### Fixed

- Invite-only registration now requires an instance invite or a team invite
  whose original creator is currently an instance admin. Other team invites
  still let existing accounts join, but cannot create new accounts. Demoting
  or deleting the creator removes a team invite's registration authority;
  resending does not grant it (#205).
- Logging in with an unknown email runs the same argon2 work as a wrong
  password, so response time no longer reveals whether an email has an
  account. Registration still answers 409 for a taken email, by design (#208).
- Audit log export filenames use the viewer's local date instead of UTC (#214).
- When two registrations race for the same email, the one that loses gets the
  usual `409` email field error instead of a server error.
- The SSRF guard refuses reserved IPv4 ranges and IPv6 addresses that carry
  an internal IPv4 address (IPv4-mapped, NAT64 and 6to4), classified by the
  address they carry. Local-only mode keeps its previous list of internal
  addresses, so it does not start trusting public hosts reached through those
  ranges (#207).
- The agentic `search_code` tool on GitHub sends the model's term as one
  quoted phrase, so search qualifiers in it (such as `repo:` or `org:`) can no
  longer point the search at other repositories. An empty term finds nothing
  instead of failing the caller search (#211).
- Turning reviews on for a repository twice at once, or after a forge request
  that timed out, no longer leaves a duplicate or orphaned webhook. The
  registration is reconciled with the forge's existing hooks by URL, and a
  hook created for a repository removed meanwhile is deleted.
- `timeAgo` rounds values that reach a full unit up to that unit instead of
  showing "60 minutes ago" or "24 hours ago", and past and future times now
  round halfway values the same way (90 seconds ago reads "2 minutes ago")
  (#213).
- The worker's forge cache can no longer grow without bound on large changes.
  It was limited to 200 entries whatever their size, so a few big monorepo
  pull or merge requests (whole file lists with patches, or full files) could
  push the worker toward running out of memory. Cached entries now also stay
  under 64 MB in total, and a single answer over 8 MB is used for the review
  but not cached. Closes #188.
- Renewing a GitLab OAuth connection's access can no longer lose the tokens
  GitLab issued. If the refresh transaction timed out or failed to commit after
  GitLab answered, the new tokens were rolled back while the old refresh token
  was already spent, and the connection needed a manual reconnect. The token
  request is now capped to the time the transaction has left, and tokens from a
  refresh whose transaction fails are still stored, unless the connection was
  updated in the meantime (#187).
- A review whose worker stalled past the lock timeout, and was retried by
  another worker, can no longer finish or fail the retry when it wakes up.
  Finishing and failing a job now apply only to the attempt that holds it, so
  the retry's result and findings are stored instead of being dropped.
  Closes #185.
- A pull or merge request that is closed and then reopened without a new push
  is reviewed again. The review cancelled by the close no longer counts as one
  already done for that head, so the reopen webhook queues it instead of
  answering `duplicate`. Closes #184.
- A forge that accepts the connection but never answers no longer hangs a
  review or a webhook. Every forge API request, including each redirect hop,
  is now aborted after 30 seconds, so the worker fails the run and frees it
  instead of keeping the whole change in memory, and webhook handlers that
  call the forge respond. Closes #186.
- Two reviews of the same pull or merge request no longer run at the same
  time. A newer push now waits for the running review to finish, so an older
  head that finishes last can no longer overwrite the newer review's summary
  comment, reopen its fixed findings or become the latest review. A review
  cancelled from the dashboard or stopped by the run time limit finishes
  stopping before the next one starts, and if a worker dies mid-review the next
  review of that change starts within about three heartbeats (3 minutes by
  default). Closes #183.
- Deleting an account no longer leaves its forge webhooks behind. Self-service
  account deletion and an admin removing a user now take Sentryward's hooks
  off the repositories of the personal workspace, and of any team where the
  user was the only member, before those workspaces cascade-delete, the same
  way deleting a workspace, connection or repository already does. Closes
  #210.

## [0.3.0] - 2026-10-31

Sentryward remains pre-1.0, and this release changes some default behaviour:
review context now follows callers two hops from the changed code, and
changing your password signs out your other sessions. AI findings still need
human verification.

### Upgrade notes

- Back up the database and `ENCRYPTION_KEY` before upgrading. The server
  applies this release's migrations on start.
- `review.impact_depth` defaults to 2, so reviews search for callers of
  callers (within a cap of 8 code searches per review). Set
  `review.impact_depth: 1` to keep the previous context.
- `REVIEW_RETENTION_DAYS` is optional and unset keeps everything, as before.
  Once a retention period is set (here or under Instance settings), the worker
  deletes and clears older review data hourly, including the findings of
  changes with no activity in that period.
- `GET /api/usage` no longer returns `recent`; API clients that read it should
  use `GET /api/usage/recent`.

### Added

- `list_dir` tool for agentic review passes (#144). With
  `review.context: agentic`, a pass can now list a directory at the change's
  head revision on GitHub and GitLab, e.g. to find a changed file's tests or
  siblings. Paths follow `read_file`'s rules (relative, no `..`), directories
  end in `/` and symlinks in `@`, a listing shows at most 50 entries, and its
  output is marked as untrusted and counted against the pass's tool budget.
  A directory larger than the forge returns in one request (100 entries on
  GitLab, 1000 on GitHub) is reported as incomplete rather than given a wrong
  count. Listings are cached by head sha like file reads.
- Phone layout for the Reviews and Findings lists (#165). Below 640px wide
  (phones, or high browser zoom) each review and finding is a stacked card
  instead of a table row, so the lists reflow at 320px without scrolling
  sideways. Cards keep every column's value, the row menu and click-anywhere
  to open; a review's earlier runs expand inside its card, and a finding's
  change title is written out rather than left in a tooltip. Findings get a
  "Sort by" picker and a direction toggle in place of the sortable headers.
  Long active-filter chips truncate instead of widening the page, and the
  pagination's "Rows per page" label reads "Rows" on phones so its controls
  wrap.
- Command palette and a global "Review a PR" action (#161). `Ctrl+K` (`Cmd+K`
  on macOS, where plain `Ctrl+K` stays the text fields' "delete to end of
  line") opens and closes a palette from any dashboard page, also from the top
  bar's Search button: it jumps to any page (admin pages only for admins, plus
  Settings), lists repositories and opens a repository's reviews, starts a
  manual review, and queues a review for a pasted pull or merge request link.
  It does not open over another dialog, sheet or menu, says when repositories
  are still loading or could not be loaded, and closing it while a link is
  being queued leaves you on the page with a "Review queued" toast to open it.
  A "Review a PR" button in the top bar opens the manual review sheet from
  every page; Home and Reviews open that same sheet.
- Keyboard navigation and severity jump for findings on the review page
  (#157). `Ctrl+J`/`Ctrl+U` move between findings in display order, `Ctrl+O`
  or `Enter` expands or collapses the focused one, `Ctrl+C` copies its agent
  prompt (or the selected text, when there is a selection), and `Ctrl+?` opens
  a dialog listing the shortcuts. Shortcuts are ignored while typing in a
  field and inside menus and dialogs, and `Cmd` is left to the browser. A sticky
  "Jump to" bar under the header shows per-severity counts of the visible
  findings and focuses the first finding of a severity; it also opens the
  shortcuts dialog. Focus from the keyboard, a jump, Tab or a click shares one
  position, and the focus ring stays visible after a mouse-started jump.
  `Ctrl+O` and `Ctrl+C` only act while a finding has focus, a shortcut with
  nothing to act on is left to the browser (so its own `Ctrl+J` and `Ctrl+O`
  still work, while `Ctrl+U` never opens view source on the review page),
  `Ctrl+?` follows the active keyboard layout, and a jump clears the bar even
  when it wraps on narrow screens.
- Key metrics on Home (#154). Once the workspace has a review, Home shows
  four tiles above the setup checklist: open critical/major findings, reviews
  and failed runs in the last 7 days, and estimated spend over the last 30
  days. Each links to the matching list (open findings sorted worst first,
  runs, failed runs, Usage on the 30-day window), loads with its own skeleton,
  and shows "-" if its stats fail to load. `Stat` takes a `linkLabel` so a
  linked tile can name the page it opens.
- Progress for running reviews (#156). The worker records the current stage
  on the job (new `progress` column on `review_jobs`): fetching the change,
  preparing, reviewing (with `n of m` passes, and planning, context and
  walkthrough as details), checking findings and publishing, listing only the
  steps the run's config turns on. `GET /api/reviews/:id` returns it, and the
  review page shows a step list with elapsed time instead of a single spinner
  line (queued reviews show how long they have waited, and a job requeued
  after its worker stopped says it is waiting to retry). Until the run's
  config is known only the current step is listed, so the list only grows.
  Writes are best effort, coalesced, and only made by the attempt that holds
  the job; a new claim clears them, and every run waits for its last write
  before returning.
- Privacy controls (#109). A new "Privacy and data" section of the README
  lists what Sentryward stores, what is sent to model providers and forges,
  and how long it is kept. Instance admins get an Instance settings page
  (`GET`/`PUT /api/admin/settings`, new `instance_settings` table) and
  workspace admins a Privacy page (`GET`/`PUT /api/privacy`, new
  `workspace_privacy` table) to restrict model requests to chosen providers
  and hosts (exact names, `*.example.com` wildcards, optional ports) or to
  local endpoints only (hosts that resolve to private or loopback addresses).
  A workspace can only narrow the instance policy. The policy is checked
  before a review posts anything, for every model it may call, including
  ones named in `.sentryward.yaml`: a refused review, walkthrough or verify
  model fails the review with a `Blocked by privacy policy:` reason, a
  refused fallback is skipped with a warning, thread answers post a short
  notice instead, and LLM connection save, test and model-list requests to
  a refused host are rejected before they are sent (the connection shows as
  "Blocked by policy"). Retention is now configurable from the dashboard
  (instance period, falling back to `REVIEW_RETENTION_DAYS`, which workspaces
  can shorten) and also purges the findings, posted-comment records and
  finished thread replies of changes with no activity for longer than the
  period. Every outbound model request (reviews, walkthroughs, verification,
  capability probes, thread answers and connection tests) is recorded in a
  new `llm_request_logs` audit table with its workspace, repository,
  purpose, provider, host, model, token counts, latency and outcome, never
  prompts, code or error text. Admins can browse, filter and export it as
  CSV or JSON on the Privacy page (`/api/privacy/audit-log`) and, for every
  workspace, in the Audit log tab of Instance settings
  (`/api/admin/audit-log`), and an instance audit retention period removes
  old entries.
- Cross-file impact analysis (#108). Review context now follows callers of
  changed code more than one hop (`review.impact_depth`, 1-3, default 2, 1 in
  the `fast` profile; also in the dashboard under Findings > Review context):
  each caller's enclosing function becomes the next name searched, within a
  shared cap of 8 code searches per review (generic method names such as
  `run` or `handle` are not traced), and further hops are the first context
  dropped when a pass is out of room. Callers of declarations the diff
  changes or removes, including parameters on later lines of a multi-line
  signature, are searched first and labelled `signature changed` /
  `removed`, and the review prompt asks for broken contracts to be reported
  with `evidence: contract`, the affected callers in `impact` and their files
  in `evidenceFiles`, which the summary and inline comments show as
  **Affected** for contract findings. The walkthrough lists risky areas
  (authorization checks, database writes and schema changes, API routes, and
  route handlers or auth modules reached through callers; test files never
  count) in the summary comment and the dashboard's walkthrough card, both
  hidden by `output.walkthrough_blast_radius`, and they raise its blast
  radius: at least `medium` for any risky area, `large` only for a removed
  auth check. Reviews stored before `review.impact_depth` existed still allow
  an incremental review on the next push.
- Model and review-cost benchmarking (#107). Workspace admins can set their
  own model prices under LLM Connections > Model prices (`GET`/`PUT
  /api/settings/model-prices`, `DELETE /api/settings/model-prices/:id`,
  new `model_prices` table); a review's calls are priced at them when it
  runs, ahead of the built-in table. A model nothing prices now records no
  cost and is flagged `unpriced`, so its cost reads as unknown instead of $0
  on the Usage page (totals, table and recent reviews), the Reviews stats
  strip and the review sidebar; the digest's `usageTotals`, review stats
  tokens and recent usage rows carry `unpricedCalls` for it. Ollama models
  stay free unless priced. A workspace price keyed by any prefix-stripped
  form of a router id (`cx/gpt-5.6-sol` for `openai/cx/gpt-5.6-sol`) applies,
  and the price list's models carry the `price` reviews get now, so the
  "no price" warning clears for them. A saved price's model id can't be
  changed when editing. The
  review digest now keeps per-model call time and unpriced call counts, and
  the number of findings dropped as duplicates. A Benchmarks page (`GET
  /api/benchmarks`) compares, over a period and optionally one repository,
  cost per review, tokens and mean call time per model, cost, median duration
  and duplicate rate per repository, and confirmed and false-positive
  findings per model by language and by category, naming the best model
  among those with enough decided findings. Rates are over decided findings
  (confirmed plus false positives), as in the calibration stats, and cost
  per review is over the reviews that called a model. Price overrides are
  loaded before a review's model calls. Reviews from before this change have no
  call time or duplicate count and are left out of those figures. Closes #107.

- Extended thinking, agentic context and model capabilities (#139).
  `llm.thinking` (`off`, `low`, `medium`, `high`) and `llm.verify_thinking`
  let review and verification calls reason first, mapped to each provider's
  own option on native and proxied endpoints, with the budget added to the
  output limit and the prompt ceiling, and temperature left out. The `strict`
  profile thinks `high`. `review.context: agentic` lets a pass read files and
  search code through read-only tools at the head revision before reporting
  through a `report_findings` tool, within `review.agent` caps; what it read
  reaches the verifier, and usage records steps and tool calls. What each
  model supports on each connection (thinking, tools) is probed when a model
  is tested or first used (in parallel, with a timeout, and an inconclusive
  probe is retried after a day rather than before every review), corrected at
  runtime when an endpoint refuses an option or a custom endpoint ignores
  thinking options (one retry without it, a review warning), shown under a
  connection's Capabilities, and overridable in Configuration > LLM
  (dashboard only). New endpoint `GET /api/settings/api-keys/:provider/capabilities`.
  The eval runner gains `--thinking`, `--context` and `--compare`, and three
  cross-file cases.

- Estimated model cost for reviews. Each model call now records its prompt
  cache reads and writes and reasoning tokens alongside input and output, and
  its cost, computed when the call is made from a built-in price table (exact
  model, then the id without its provider prefix or router effort suffix, then
  wildcard patterns; a model nothing matches costs $0, as do Ollama models,
  which run on the user's own hardware). A model attempt whose reply could
  not be used still counts its billed tokens, recorded as a failed call, so
  the estimate includes spend a fallback model was needed for. Costs are stored with
  the review, so a later price change leaves past reviews as they were, and
  reviews from before this record none. `GET /api/reviews/stats` sums them into `cost`, review
  summaries carry `usageTotals.costUsd` and per-model costs, the stats strip
  gains a Tokens tile and the review sidebar an Estimated cost row. Closes #87.
- A Usage page (`GET /api/usage`) for code-review model spend: totals with
  input, cached and output tokens and the estimated cost, a tokens / calls /
  cost chart over 24 hours to all time, usage by provider and top models, the
  latest reviews that called a model, and a table by model or by repository
  showing costs (input, cached, output) or tokens. The Reviews page's Tokens
  tile links to it. Charts use recharts, and the chart colour tokens are now a
  colour-blind-checked palette in both themes.
- `REVIEW_RETENTION_DAYS` to stop review data growing without bound. When set,
  the worker hourly deletes superseded, skipped and cancelled reviews older
  than the window and clears the stored result, resolved configuration and
  publication of older finished ones, keeping their row, verdict and summary so
  lists, stats and the findings list are unaffected. The newest completed or
  partial review of each change is never cleared, so its findings' details,
  inline-thread answers and incremental reviews keep working. Pruning runs in
  batches. The review page says when a result has expired and its markdown
  export returns 410.
  Unset keeps everything. Includes a migration (a `result_expired_at` column
  and an index on review jobs). Closes #86.
- Notifications for finished reviews. Workspace admins add targets under
  Notifications: an outgoing webhook signed with an HMAC-SHA256
  `X-Sentryward-Signature` header (the secret is shown once), a Slack
  incoming webhook, or email to chosen members through the existing mailer.
  Each target picks its events (blocked, failed, completed), can send a test,
  and gets one delivery per review. The worker sends them best effort once a
  review finishes, fails or times out: a failed delivery is logged and never
  fails the job. URLs are stored encrypted and go through the same production
  host checks as self-hosted forges. Includes a migration (a
  `notification_targets` table and a `notified_at` column on review jobs).
  Closes #85.
- Personal API tokens for scripts and CI. Create them under Settings > API
  tokens, with a name and an optional expiry. The value is shown once and only
  its hash is stored. Requests send it as `Authorization: Bearer <token>` and
  act as the token's user, with the workspace header choosing the workspace.
  A token can read anything its user can and queue or rerun reviews; other
  writes, and managing tokens, need a signed-in session. Revoked or expired
  tokens get 401, token requests share their user's rate limit, and deleting
  the account deletes its tokens. Includes a migration (an `api_tokens`
  table). Closes #84.
- Password reset. "Forgot password?" on the login page emails a single-use
  link that expires after 1 hour, and the request answers the same way
  whether or not the email has an account. Without mail configured, the page
  asks the user to contact an admin, who can create a reset link (single use,
  24 hours) from the user's actions on the Admin page, with or without mail.
  Setting a new password signs the user in and ends every other session.
  Includes a migration (a `password_resets` table and a `session_version`
  column on users). Closes #83.
- Findings are classified across runs as new, still open, reopened, fixed
  or invalidated. Each review after a change's first records this in its
  result (`lifecycle`), and the summary comment opens its findings with a
  "Since the last review" line and a list per group, at most 20 entries each
  (`output.finding_lifecycle` turns it off). A finding counts as invalidated
  rather than fixed when its file was renamed, deleted or dropped from the
  change, or the same problem now appears in a file the change adds or
  renames and is the only one of its kind (that finding is still open, not
  new). A finding resolved earlier and reported again is reopened. Findings
  carry a `lifecycle` column, `GET /api/findings` filters by `lifecycle`, the
  findings page gains a "Last review" filter, and invalidated findings no
  longer count as resolved in the stats. Includes migrations (a
  `finding_lifecycle` enum and column, backfilled from each finding's state,
  and an `end_line` column so gone findings keep their line range). Closes
  #104.
- Structured evidence on findings. The model now returns a finding's
  `impact` (what breaks, and for whom) and `fixRationale` (why the suggested
  fix works) as separate fields instead of folding them into the body; inline
  comments, the summary comment, agent prompts and the dashboard show them
  under their own headings. Each finding also records what `review.verify`
  made of it (`verified`, `uncertain` or `not_checked`): forge comments mark
  verified and uncertain findings, and the dashboard shows a badge for all
  three. Results stored earlier have none of these and read as not checked.
- `GET /api/findings/calibration?repoId=&days=&groupBy=` measures how the
  confidence models self-report has matched outcomes: findings bucketed by
  reported confidence in tenths, with confirmed (fixed) and false-positive
  rates over the findings that were decided, overall or by `model` or
  `category`. The False positives tab gains a card showing it. Includes a
  migration adding a `confidence` column to findings, backfilled from each
  finding's last run (null for tool and rule findings). Closes #105.
- Team rules in `.sentryward.yaml`. A `rules` list states a convention once,
  with an `id`, `description`, `severity` and optional `category`, `paths`
  globs and `good`/`bad` examples, read from the base revision like the rest
  of the file. A rule with a
  `pattern` (an RE2 regular expression, matched in linear time) is checked
  against the change's added lines without a model, so the same diff always
  gives the same findings; the rest are given to the model, and a violation it
  reports is filed under the rule with the rule's severity. Both are reported
  with source `rule` and the rule's id, block at `review.block_on`, are
  reported whatever `review.categories` holds, and are marked with the rule in
  forge comments and the dashboard. The False positives tab gains a per-rule
  table, and a change to the rules makes the next push a full review. Includes
  a migration adding a `rule_id` column to findings. Closes #106.
- Team rules in dashboard settings. The global config (every repository in
  the workspace) and repository settings can hold a `rules` list, edited on
  the Configuration page's Guidance tab. Unlike other lists, rules combine
  across layers in the order global config, repository settings,
  `.sentryward.yaml`: a later layer can add rules but never remove or override
  an earlier one, so a rule reusing an id is ignored with a review warning,
  and a layer whose rules would take the combined list past the limits is left
  out as a whole, with a warning. Repository settings whose rules clash with
  or do not fit beside the global ones are refused on save, and the global
  config lists repositories whose rules it leaves out. Dashboard rules keep the
  dashboard's `severity_floor` and `min_confidence` (a repository file can only
  lower them for those rules), and their patterns still run on files only the
  repository file ignores. The effective config names each rule's layer
  (`sources["rules.<id>"]`). The editor checks patterns with the server's RE2
  as they are typed (`POST /api/config/rules/check`), and inline comments for
  rule findings include the rule's description and paths, since dashboard
  rules are not visible in the repository. Closes #140.
- Notification targets can be paused. Admins switch a target off from the
  Notifications list (`PATCH /api/notifications/:id` with `active`) to stop
  its deliveries while keeping its name, events, recipients, URL and signing
  secret, and switch it back on later. Reviews that finish while a target is
  paused are never sent to it, even after it is resumed. The list sorts and
  filters by status, paused targets still accept test deliveries, and members
  see the switch but cannot change it. Existing targets stay active (migration: an `active` column on
  `notification_targets`, default true). Closes #130.
- Actionable states for reviews that did not succeed (#158). A failed,
  cancelled or skipped review offers Re-run in its alert (not while the
  repository's reviews are off, by hand or after lost access, since the server
  refuses it), plus a link to
  the page that fixes the cause: LLM Connections for a missing, removed or
  mismatched key, the review settings when no connection is selected, the
  Installation tab for refused forge credentials or lost access, Repositories
  for reviews turned off, Privacy for a blocked model, and the repository's
  Triggers tab for a skip (noting when `.sentryward.yaml` sets the trigger).
  `GET /api/reviews/:id` now returns `errorKind`, derived from the stored
  error when read (including errors recorded as a failed review pass), so
  older reviews get one too and no migration is needed, and
  `repository.enabled`, which decides whether Re-run is offered.
  "Review not found." links to the reviews list.
- Unsaved-changes guard on the Review settings, Privacy and Profile forms
  (#163). Leaving a form with unsaved edits (a link, Back, switching the
  Review settings scope from the picker or any link, or a Settings or
  Instance settings tab that hides the form) asks to keep editing or discard,
  and reloading or closing the tab shows the browser's prompt. Switching the
  Review settings tabs never asks. While there are edits, the Review settings and Privacy save bars
  pin to the bottom of the page, and Review settings gains a Discard button.
- Each Review settings field tags its effective value with where it comes
  from: `default`, `profile: <name>`, `global`, `repo override` or the
  repository file (#164). In a repository's scope, a field the repository
  file sets is locked, with a tooltip saying the file wins over the dashboard.
- Sidebar attention indicators (#162). Reviews shows a count of runs that
  failed since you last opened the list (the last 24 hours before your first
  visit), counting only a change's latest run, as the list's default view
  does, and LLM Connections and Repositories show a warning dot when a
  connection is revoked, unreachable, blocked by policy or unreadable. The
  sidebar starts no credential checks of its own: it shows stored flags and
  the checks those pages and Home already ran. The
  state is part of each link's accessible name and tooltip, and a collapsed
  sidebar keeps a dot on the icon. New `GET /api/reviews/attention` and
  `POST /api/reviews/viewed` endpoints, backed by a new
  `memberships.reviews_viewed_at` column, track the visit per member and
  workspace, so it clears on every device. Leaving the list on a workspace
  switch records the visit in the workspace that was open.
- Drag-to-reorder connections. Workspace admins can drag a connection card by
  its handle (or move it with the keyboard: Space, arrow keys, Space) to set
  the order everyone in the workspace sees. The order is saved by the new
  `PUT /api/connections/order` endpoint in a new `forge_connections.position`
  column; connections added later go after the ordered ones. Reordering is
  off while searching or filtering, since the order belongs to the whole list.
  Quick successive drags are saved one after the other, so the last order
  chosen is the one stored, and overlapping saves (two admins at once) wait
  for each other instead of failing. A save refused because the list changed
  says so rather than showing a generic error.
- "Reconnect" on a connection whose credentials the forge rejected. It opens
  the connect sheet with that connection's provider, hosting option and host
  already filled in, so connecting the same account again resumes automatic
  reviews and keeps its repositories and history.
- Drag-to-reorder repositories, the same way as connections. The order is
  saved by the new `PUT /api/repos/order` endpoint in a new
  `repositories.position` column. `GET /api/repos` still lists by path (the
  pickers elsewhere rely on that) and now returns each repository's
  `position`, which the Repositories tab sorts by, with unplaced ones last.
- Each repository card shows its last review: the verdict (or status while it
  is queued, running or failed), the pull or merge request number and how long
  ago, linking to the review. The new `GET /api/repos/last-reviews` endpoint
  returns them, read in one query, so pages that only list repositories don't
  pay for it; skipped and superseded runs don't count. A new
  `review_jobs (repository_id, created_at)` index serves it.

### Changed

- The Installation tab lists connections as a grid of cards instead of a
  table. Each card shows the account, host, connection type, status,
  repository count and who added it and when, with "Manage repositories" and
  "Details" buttons; the menu keeps Details and Remove. Column sorting and
  pagination are gone from this tab, replaced by the saved drag order, and
  it shows skeleton cards while loading instead of a blank area. Its search,
  filter and "Add connection" controls sit on the left, in that order.
- The Repositories tab lists repositories as a grid of cards instead of a
  table, with the same left-aligned search, filter and "Add repository"
  controls. Each card shows the path (linking to the forge), account, default
  branch, connection status, whether it uses global or custom settings, its
  last review and the review switch. Column sorting and pagination are gone
  from this tab, replaced by the saved drag order; it shows 24 cards at a
  time with a "Show more" button. Turning reviews on or off now only locks
  that repository's switch while it saves, not every switch.
- LLM Connections shows every provider as a card, connected or not, instead
  of a table of stored keys with search, filters, sorting and pagination. Each
  card states what its reviews use (your key, the server's key, or nothing),
  explains a problem in visible text and offers the action that fixes it:
  "Replace key" for a rejected or unreadable key, "Check again" for one that
  could not be verified, and a link to the privacy policy (with "Connect"
  disabled) for a provider it blocks. "Connect", "Use my own key" and
  "Replace key" open a sheet for that card's provider (no provider picker),
  with a link to where the key is created and the custom host under
  "Advanced". Testing a model and the capability list move into one Details
  sheet per connection. Cards show when the status was last checked and can
  check it again, the page header sums up how many providers are connected
  and how many need attention, and the page shows placeholders while loading
  and a retry on error. The "Inactive" and "Unknown" statuses read "Key
  rejected" and "Couldn't verify". The cards are laid out like the
  Repositories page's, and workspace admins can drag them by their handle
  (or move them with the keyboard) into an order saved for the workspace.
- Redesigned login, sign-up, password reset and invite pages. On wide screens
  they split into a product panel (what Sentryward does, light or dark with
  the theme) beside the form; on phones only the form shows, under the logo.
  Password fields get a show/hide toggle, sign-up and reset show a live
  strength meter and a "Passwords match" check (advisory, the 8-character
  minimum is still the only rule), inputs carry icons, and the first field
  is focused. Errors that aren't about a field, like wrong credentials,
  appear as an alert in the form instead of a toast, and the first user's
  "you will be admin" note is an info alert. The product panel plays an
  example review on a loop: a small diff gets an inline finding (severity,
  title typed in, explanation and a suggested change), then the
  `sentryward/review` status turns into a verdict, across three examples.
  Behind it, a slow brand-blue waveform drawn as dithered vertical bars
  (wider where it is brighter) drifts across the right of the panel, fading
  out under the text. Both only run while the panel is on screen and the tab
  is visible, and hold still with reduced motion.
- The review page header groups "Copy prompt for all findings", "Copy
  markdown" and "Download markdown" into an Export menu (#155), leaving Re-run
  (and Cancel while the review is active) as the only buttons. Items keep
  their disabled states, and the Export button shows a spinner while a
  markdown copy or download is still running.
- Rows in the Reviews and Findings tables open on a click anywhere outside
  their controls (#160), not just on the title. The title stays a real link
  (or button), so middle-click and Cmd-click still open a new tab, and the
  runs toggle, forge link and row menu do not open the row. Modified clicks
  and clicks that end a text selection are left alone.
- The Reviews and Findings lists keep their filters, search, view and sort in
  the URL (#159), so Back from a review restores the list and a copied link
  reproduces it. Values the page does not know fall back to defaults. Each
  Findings tab keeps its own (`?fpSeverity=` and so on for false positives),
  switching tabs keeps both, and a review's "Back to reviews" link returns to
  the filtered list it was opened from, also after a re-run from the review.
- The client uses a data router (`createBrowserRouter`) so forms can block
  navigation; routes still live in `App.tsx`.
- Home replaces the status hero with a setup checklist built from live
  data: connect GitHub or GitLab, enable a repository, connect an LLM
  provider (with the same usability checks the hero had) and run a first
  review. Finished steps are ticked, the next one gets the primary button,
  and the checklist disappears once every step is done. Only a completed or
  partial review counts as the first one (skipped, failed and cancelled runs
  don't), and its "Review a change" action waits until the steps before it
  are done. A list that fails to load counts its step as done rather than
  asking for something that may exist. Suggested actions no longer list
  setup steps: "Can't reach your LLM provider" appears while a key fails its
  status check (instead of reopening setup), "Review a change" after the
  first review, and "Turn on automatic reviews" once setup is done but only
  requested reviews run. Closes #153.

- `GET /api/settings/api-keys` reports `blocked` per provider: whether the
  privacy policy refuses that provider or its host, whichever key is used.

- The dashboard sidebar is split into labelled groups: Activity (Reviews,
  Findings), Insights (Usage, Benchmarks), Workspace (Repositories, LLM
  Connections, Review settings, Notifications, Privacy, in setup order) and,
  for instance admins, Administration (Users, Instance settings). This
  replaces the "User Management" collapsible. The current team's page moved
  from the sidebar to a "Team settings" item in the workspace switcher (team
  workspaces only). The breadcrumb now starts with the page's group, and the
  Configuration page is renamed Review settings (its `/configuration` URL is
  unchanged).
- The Privacy page's Policy tab shows the workspace policy form with an
  "In effect" summary beside it (the stricter of the instance and workspace
  policies; stacked on narrow screens). The policy form (also used by
  Instance settings) is split into "Where code can be sent" and "Data
  retention" sections. Allowed providers is a multi-select dropdown in
  which providers the instance blocks are disabled, retention has a "days"
  unit and presets, retention above the instance limit is caught before
  saving, and a Reset button undoes unsaved changes. Members see a note
  that only owners and admins can edit.
- Model prices moved to their own tab on the LLM Connections page
  (`/llm-connections?tab=prices`), next to the Connections tab. The
  Benchmarks page's "Unknown" cost link opens that tab.
- The Delete account card moved to the bottom of the Profile settings tab
  and the Account tab is gone. Old `/settings?tab=account` links open the
  Profile tab. Closes #146.
- Changing your password in Settings now signs you out on other devices,
  keeping only the current browser signed in. Existing sessions stay valid
  through the upgrade.
- The Reviews page's changes view counts its total with one SQL query
  instead of loading every pull/merge request key matching the filters, so
  page loads and polls no longer grow with the whole review history. Totals
  are unchanged for every filter. Closes #89.
- Copying and downloading a review's markdown share one helper on the
  client, so the review page and the Reviews table row menu fetch it, report
  failures and track pending state the same way. The row menu's copy now
  goes through the same clipboard path as the review page. Closes #95.
- Confidence is labelled as self-reported wherever it appears: the dashboard
  shows "Self-reported confidence" instead of a bare percentage, the minimum
  confidence setting says it is the model's own estimate, and forge comments
  still never show it.
- The Usage page paginates its lists. Recent reviews now pages through every
  review that used a model in the period instead of only the latest 10. It is
  served a page at a time by the new `GET /api/usage/recent` (`page`, `limit`
  up to 100), and `GET /api/usage` no longer returns `recent`. It and the
  Usage by Model / Usage by Repository table page separately
  (`?recentPage=`, `?usagePage=`). The table sorts across every row before
  paging. A new period sends both lists back to page 1, and so does a new
  sort, view or Costs/Tokens mode for the table. Each table's rows-per-page control now has
  its own id, so two on one page keep their labels. Closes #132.

### Fixed

- The "Sign up" link could disappear from the login page.
  `GET /api/auth/registration` shared the login rate limit (20 per 15
  minutes), and every auth page load reads it, so reloading those pages
  could exhaust the allowance; it now uses the general API rate limit.
- The home status no longer says "Reviews are on" when the workspace has no
  usable LLM connection: it asks for one first. A server-provided key counts
  as usable unless the workspace stored its own key for that provider (reviews
  use the stored one, so a revoked stored key counts as missing) or the
  privacy policy blocks the provider. A provider that does not answer its
  status check gets its own "Can't reach your LLM provider" message instead.
  Closes #152.

- An open finding in a file the change later deletes is now resolved (as
  invalidated) instead of staying open forever: a deleted file is never
  reviewed, so the run never got to say the finding was gone.

- Webhook deliveries for one PR/MR that arrive at the same moment (two quick
  pushes, a push and a `/sentryward review` comment, or a redelivery) queue
  one review instead of reviewing the same head twice. Enqueues for a change
  are serialized, and the close cancel and stale-job recovery follow the same
  rule: a recovered job is superseded when a newer one is already queued.
  No migration needed. Closes #82.
- A token or OAuth connection whose credentials the forge refuses (revoked
  or expired token, withdrawn OAuth grant, a token the server can no longer
  decrypt) no longer queues a failing review on every push. Sentryward
  records the refusal, either from the connection status check or from a
  review that hits a 401/403 confirmed by an account check. It then stops
  queueing reviews from that connection's repository hooks, skips webhook
  reviews already queued, and shows "Automatic reviews are paused" on the
  Repositories page. Connecting the same account again with a new token (or
  signing in again) resumes reviews and keeps the history, as does a status
  check that passes. Manual reviews still run. Includes a migration (one
  nullable column). Closes #103.
- Searching reviews by title ignores case, like the repository path search,
  in both the runs and changes views: `fix login` now finds "Fix login
  redirect". Includes a migration that adds a `title` column to review jobs
  and backfills it from each review's summary. The worker stores the title as
  soon as it fetches the change, so skipped, cancelled and failed runs are
  found by title and show it in lists too. A second migration adds trigram
  indexes (`pg_trgm`) on review titles and repository paths so the search
  does not scan the whole table. Closes #88.
- Client tests for the markdown download: the success test now waits for
  Download markdown to be enabled again, so a stuck spinner fails it, and the
  object URL stubs are restored after each test instead of leaking into later
  ones. Test-only, no behaviour change. Closes #90, closes #91.

## [0.2.0] - 2026-10-22

Sentryward remains pre-1.0, and this release changes some default behaviour:
pushes get incremental reviews, and findings dismissed as a false positive or
as intentional are no longer reported again on the same PR/MR. AI findings
still need human verification.

### Upgrade notes

- Back up the database and `ENCRYPTION_KEY` before upgrading. The server
  applies this release's migrations on start.
- GitHub App: grant the **Checks** (read) permission so static analysis results
  can be read, and subscribe to the **Pull request review comment** event so
  replies on inline comments are answered. Without them, reviews still run.
  GitHub repositories connected with a token have a per-repository webhook
  without that event; turn reviews off and on again for each to recreate it.
- GitLab OAuth is optional: set `GITLAB_OAUTH_HOST`, `GITLAB_OAUTH_CLIENT_ID`
  and `GITLAB_OAUTH_CLIENT_SECRET` and register
  `<url>/api/connections/gitlab/oauth/callback` as the redirect URI.
- `WORKER_HEARTBEAT_INTERVAL_MS` (60 seconds by default) must stay below
  `WORKER_LOCK_TIMEOUT_MS`, or the server and worker refuse to start.
  `WORKER_MAX_RUN_MS` (30 minutes by default) fails reviews that run longer;
  raise it if your reviews take that long.
- To keep the previous behaviour, set `triggers.full_review_on_push: true` and
  `review.suppress_ignored: false`.

### Added

- Review details show a Validation card with how many candidate findings were
  left out of the review, by reason (low confidence, duplicate, outside
  changed lines, ...), and how many were downgraded because evidence was
  missing or unverified. Only counts are shown, never the discarded findings,
  and the card is hidden when nothing was filtered or downgraded.
- Replies on Sentryward's inline comments get a response in the thread.
  `/sentryward ignore false-positive|intentional [note]` ignores the finding
  with that reason and note, as the dashboard does, and is acknowledged; any
  other reply is answered once, briefly, by the review model from the finding
  and its code, with the reply passed as untrusted data. Only people who can
  push are answered, the bot never answers itself, and at most 10 replies per
  PR/MR per hour are acted on. Turned off with `triggers.replies` or the new
  "Respond to replies" switch. GitHub needs the **Pull request review
  comment** webhook event (added to new per-repository hooks; add it to the
  GitHub App's events). Replies are queued in a new `thread_replies` table and
  answered by the worker; requires a database migration.
- GitLab can be connected through OAuth ("Connect with GitLab") as well as
  with an access token, on GitLab.com or one self-hosted instance per
  deployment, configured with `GITLAB_OAUTH_HOST`, `GITLAB_OAUTH_CLIENT_ID`
  and `GITLAB_OAUTH_CLIENT_SECRET`. The flow uses PKCE and a single-use state.
  The access and refresh tokens are stored encrypted, and the access token is
  refreshed shortly before it expires, one refresh at a time per connection
  since GitLab rotates the refresh token on each use. If GitLab refuses a
  refresh, the connection shows as inactive and reviews fail asking you to
  reconnect. An OAuth connection posts as the person who signed in. Backed by
  `GET /api/connections/gitlab/oauth/start` and
  `GET /api/connections/gitlab/oauth/callback`; requires a database migration.
- The findings page breaks the false-positive rate down by category, severity
  and model, so it shows where reviews are noisy. Groups with fewer than 5
  findings are hidden, and groups at 30% or more link to the setting that would
  quiet them (the reviewed categories, the minimum confidence or severity
  floor, or the model), scoped to the repository selected on the page. The
  model is the one whose review pass raised each finding, now stored on the
  finding (existing rows are backfilled from their last run where it used a
  single model) and kept as it was once a finding is ignored, so a dismissal
  never moves to a later model. Served as `falsePositivesBy` on
  `GET /api/findings/stats`.
- A "Test model" action on each LLM connection runs one minimal generation
  against a chosen model with the stored credential, through the same path a
  review uses, and reports the response time and token usage or why it failed
  (rejected key, model not served, host unreachable, or a reply reviews cannot
  parse). The secret stays on the server. Backed by
  `POST /api/settings/api-keys/:provider/test`.
- `output.walkthrough_labels` and `output.walkthrough_blast_radius` (on by
  default, "Show labels in the summary" and "Show blast radius in the summary"
  on the Display tab) hide the labels and blast radius segments of the
  walkthrough's meta line in the summary comment and the copied markdown,
  without dropping the rest of the walkthrough. The native PR/MR labels
  (`output.blast_radius_label`, `output.effort_label`) are unaffected.
- `output.finding_counts` (on by default, "Show finding counts" on the
  Display tab) turns off the findings-count line under the verdict in the
  summary comment and the copied markdown, without dropping the rest of the
  comment.
- Static analysis results already on the forge are reported as findings,
  marked with the analyzer's name: check run annotations on GitHub (including
  CodeQL), and Code Quality and SAST reports from the head pipeline on GitLab.
  Only results on lines the change added are kept. They pass the same
  category, severity floor, dismissal and finding-limit rules as model
  findings, and where the model reported the same problem its finding is kept.
  `review.tool_findings` (on by default) turns this off, and
  `review.tool_findings_block` (off by default) lets them fail the verdict. The
  GitHub App needs the Checks (read) permission; without it, or when a report
  cannot be read, the review continues with a warning.
- Reviews triggered by a push are incremental: only files the new commits
  touched since the last completed review are reviewed again (each with its
  whole PR/MR diff), and that review's findings on the other files are carried
  over, so they stay open, still count toward the verdict and are not posted
  again. The summary comment names the reviewed commit range. A force push or
  rebase, a partial or failed last review, a comparison the forge cannot
  answer, and manual or `/sentryward review` requests all get a full review.
  `triggers.full_review_on_push` (off by default) reviews the whole change on
  every push instead.
- Review passes see the code around the diff, not just the hunks: the
  enclosing function or class and the imports of each changed file, the
  definitions of functions the diff calls, and call sites of the functions it
  changes, read at the head revision. Context only uses budget the diff left,
  never causes an omission, and a failed read only adds a warning.
  `review.file_context` (on by default) turns it off.
- Findings dismissed as a false positive or as intentional are no longer
  reported again on the same PR/MR, including after verification demotes a
  finding onto a dismissed one. Recent dismissals from the repository are also
  listed in the review prompt (bounded, and treated as untrusted text) so the
  same false positive is less likely on later PRs. "Fix later" and "not
  specified" dismissals are not used. `review.suppress_ignored` (on by default)
  turns it off, from the dashboard or `.sentryward.yaml`.
- When a change is split into several review passes, every pass gets a
  bounded list of all reviewable files with their change type, line counts and
  the walkthrough's one-line summary, so problems spanning files in different
  passes are visible. In that case the walkthrough runs before the passes
  instead of alongside them; if it fails, the passes still get the file list.
- An evaluation harness for review quality (`npm run eval` in `server/`): a
  corpus of 21 small changes in TypeScript, Python and Go with expected
  findings and known traps, reviewed with a real model and scored by file and
  line overlap. Reports precision, recall, false positives per case, tokens and
  cost to a JSON file so runs can be compared. Not part of `npm test` or CI.
  Single-pass reviews are unchanged.

### Fixed

- Uninstalling the GitHub App no longer deletes its connection, and with it
  the repositories, reviews and findings. The connection is detached (it shows
  as revoked and API calls on it return 409), and installing the app again on
  the same account reattaches it, even if the account was renamed or the
  uninstall webhook never arrived. Repositories removed from the installation
  are disabled and come back when access is granted again, while one a user
  disabled stays disabled. The dashboard no longer suggests removing an app
  connection. Requires a database migration. Closes #81.
- Rerunning a review on a repository whose reviews are turned off is refused
  with a 409, like a new manual review, instead of queueing and publishing a run.
- Turning reviews off for a repository cancels its queued and running reviews
  ("Reviews were turned off for this repository"), and the worker skips any
  job whose repository is off when it starts, so nothing more is published to
  it. A running review also stops between publishing steps, and its pending
  commit status is set to `success` so a required check is not left blocked.
  The GitHub App losing access to a repository cancels its reviews the same
  way ("Sentryward lost access to this repository"). After turning a
  repository back on, automatic triggers review those heads again. Closes #80.
- A cancelled review replaces its "Reviewing..." progress comment with a short
  "Review cancelled" note instead of leaving it on the PR/MR.
- **Download markdown** attaches its temporary link to the page while clicking
  it and frees the file's URL only after the click, so the download also works in
  browsers that ignore a detached link or start downloads asynchronously.
- Copy markdown now shows a spinner and prevents repeated requests while copying a review.
- Secrets stored under a previous `ENCRYPTION_KEY` no longer cause raw crypto
  errors or 500s. API keys are still listed, shown as "Unreadable" with a
  "Re-enter key" badge, and checking or listing models for one returns a 409
  asking to re-enter it. Forge connections with an unreadable token show as
  revoked and ask to be reconnected. A review that needs an unreadable key
  fails with a message saying where to re-enter it. A repository whose webhook
  secret cannot be read rejects deliveries with the usual 401 and logs a
  warning; disabling and enabling the repository registers a fresh secret.
- A long-running review is no longer falsely requeued and eventually marked
  `failed` with "Worker stopped responding". The worker now refreshes a job's
  lock on a heartbeat while it runs (`WORKER_HEARTBEAT_INTERVAL_MS`), so
  stale-lock recovery only reclaims a worker that has actually gone silent, not
  a slow-but-healthy run that crossed `WORKER_LOCK_TIMEOUT_MS`; the server
  refuses to start when the heartbeat is not below the lock timeout.
  `WORKER_MAX_RUN_MS` (30 minutes by default) caps how long a review may take:
  a run past it is failed with an accurate reason and its concurrency slot is
  freed, so one stuck job cannot stall the worker. A run that loses its job,
  to that cap or to stale-lock recovery, stops and publishes nothing more, so a
  retried review is no longer posted twice.
- Reviews through a self-hosted LLM gateway behind a proxy (such as Cloudflare)
  no longer fail with an empty-message `AI_APICallError`. The proxied model path
  now streams the response instead of waiting for the whole completion, so a
  long generation keeps the connection active and does not trip the proxy's
  origin timeout (e.g. Cloudflare's 524). Behaviour on the official provider
  APIs is unchanged.
- A partial or failed review with no findings no longer shows the reassuring
  "Nothing in this change needs attention." empty state. It now says review
  coverage was incomplete, so incomplete runs are not mistaken for all-clears.

## [0.1.0] - 2026-10-13

First stable release. Sentryward remains pre-1.0; minor releases may include
breaking changes. AI findings still need human verification.

### Added

- Instance admins. The first account on an empty install becomes the admin (on
  an existing install, the oldest account does). Admins manage users from the
  **Users** page, promote or demote other admins, and create instance invites.
  An instance always keeps at least one admin.
- `REGISTRATION_MODE` (`open`, `invite` or `closed`) controls who can create an
  account. The first account is always allowed. The login page hides its
  sign-up link unless registration is open or the instance has no accounts.
- Invite links that work once and expire after 7 days, optionally limited to one
  email. Tokens are stored only as hashes. With `SMTP_URL` and `MAIL_FROM` set,
  invites are emailed, and resending one rotates its link and renews its expiry.
- Team workspaces with their own forge connections, repositories, reviews,
  findings, global review config and LLM keys. Members have an `owner`, `admin`
  or `member` role: admins manage settings and members, and only owners grant,
  revoke or hold ownership. A team always keeps at least one owner.
- Team invites, accepted by existing users or used to register a new account,
  and adding existing accounts to a team directly from a searchable picker.
- A workspace switcher in the sidebar, a **Team** page (`/workspace`) with
  members, pending invites and settings, and a **User Management** sidebar group.
- Profile pictures, shown across the dashboard and in member lists.
- A production deployment path: one image (`ghcr.io/rdlugs/sentryward`, built
  from `docker/Dockerfile`) that runs the API, serves the built dashboard and
  runs the worker; `docker-compose.prod.yml` with an unpublished database and a
  loopback-only API port for a TLS reverse proxy; `.env.production.example`; and
  a README "Deploying" section. Release tags publish the image to GHCR for
  `linux/amd64` and `linux/arm64`. The worker takes the `WORKER_*` settings
  from the env file and gets up to `WORKER_STOP_GRACE_PERIOD` (15 minutes by
  default) to finish in-flight reviews when stopped or upgraded.
- `STATIC_DIR` serves a built client from the API, and `TRUST_PROXY` sets
  Express's trusted proxy hops so rate limits see client addresses behind a
  reverse proxy.

### Changed

- Dashboard routes load on demand to reduce the initial JavaScript bundle. A
  failed route download offers a reload so the dashboard can recover after an
  upgrade.
- **Bammy is now Sentryward**, with a new logo. Every identifier changed with the
  name and there are no fallbacks:
  - the repository config file is `.sentryward.yaml` (or `.sentryward.yml`);
    rename any `.bammy.yaml`.
  - the comment command is `/sentryward review`.
  - the commit status is `sentryward/review`; update branch protection rules
    that required `bammy/review`.
  - hidden comment markers are `<!-- sentryward:... -->`, so the first review of
    a PR reviewed before the rename posts a fresh summary and inline comments
    instead of editing the old ones.
  - the session cookie is `sentryward_token`, so everyone signs in again once.
  - the Docker Compose project and default Postgres user/database are
    `sentryward`, so a local install starts with a new, empty database volume.
- Existing connections, LLM keys and global review configs move into each user's
  new personal workspace, so nothing changes for single-user installs.
- API requests choose a workspace with the `x-sentryward-workspace` header. Without
  it they act on the caller's personal workspace, so existing scripts keep
  working. The GitHub App install link takes `?workspace=` instead.
- `WORKER_USER_CONCURRENCY` now limits running reviews per workspace rather than
  per user.
- Switching workspaces clears the dashboard's cached data, so nothing from one
  team shows in another.

### Security

- Deleting an account locks the team memberships involved, so two owners leaving
  at the same moment cannot leave a team without an owner.
- Adding a team member by email, and the add-member picker, show team admins
  which emails have accounts on the instance. This is deliberate, so existing
  users can be added in one step.
- KaTeX, which Mermaid diagrams use for math, is pinned to 0.18.x for
  [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7).
  Mermaid still requires 0.16.x, so the client overrides it.

## [0.1.0-alpha.2] - 2026-10-05

### Security

- Forge requests now stay on the connection's own host. Pagination links and
  redirects that point elsewhere are refused, so a self-hosted forge can no
  longer steer the server, with its access token, to internal addresses that
  the production host check is meant to block.

### Added

- Rate limits for the API (600 requests per minute per user, or per address
  before sign-in) and for webhooks (300 per minute per address).

### Fixed

- Text containing backslashes before a pipe no longer loses characters in the
  summary comment's tables.

## [0.1.0-alpha.1] - 2026-10-05

First public alpha.

### Added

- Review engine: diff parsing, language detection, ignore globs, token-budgeted
  chunking, concurrent review passes, an optional walkthrough, finding validation,
  severity and verdict, and fingerprints that dedupe findings across runs.
- Review worker with a PostgreSQL-backed job queue, per-user concurrency limits,
  and stale-lock recovery.
- GitHub (via a GitHub App) and GitLab (including self-hosted) forge connections.
- Publishing to the forge: inline comments with suggestions, a single summary
  comment with agent prompts, and a `sentryward/review` commit status, each step
  independent.
- Review triggers: manual review by URL or from a picker of open changes, re-runs,
  webhooks, and `/sentryward review` comments.
- Layered review configuration: trigger overrides, `.sentryward.yaml` from the base
  revision, dashboard repository settings, profiles, and defaults, with per-field
  source tracking.
- Model providers Anthropic, OpenAI, and Google, plus custom endpoints and Ollama.
  LLM connections verify stored keys.
- Dashboard: home overview, reviews list, review detail with a live forge preview,
  repository and connection management, findings management, duration and
  false-positive stats, account settings, and a density setting.
- Markdown and JSON review output through the API.
- Open-source project files: MIT license, third-party notices, contributing guide,
  code of conduct, security policy, issue and pull request templates, and a
  Docker-based GitHub Actions CI workflow.

### Security

- Passwords are hashed with Argon2id. Authentication uses an httpOnly JWT cookie.
- Forge tokens, webhook secrets, and model API keys are encrypted at rest with
  AES-256-GCM.
- `NODE_ENV=production` enables secure cookies and HTTPS/public-address checks for
  self-hosted forge hosts.
- Dependency audit: server findings in the Prisma toolchain are fixed through npm
  overrides. Client findings in shadcn build tooling are accepted for this alpha
  (see [the release checklist](docs/RELEASE_CHECKLIST.md)).

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and deployment
boundaries.

### Known limitations

- Alpha software: features, configuration, and the API may change.
- AI findings need human verification and can miss problems or report false
  positives.
- The Docker Compose setup is for development, not public production hosting.
- Registration is open, with no invitation gate.

[Unreleased]: https://github.com/rdlugs/sentryward/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rdlugs/sentryward/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rdlugs/sentryward/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rdlugs/sentryward/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rdlugs/sentryward/compare/v0.1.0-alpha.2...v0.1.0
[0.1.0-alpha.2]: https://github.com/rdlugs/sentryward/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/rdlugs/sentryward/releases/tag/v0.1.0-alpha.1
