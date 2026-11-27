# Changelog

All notable changes to Sentryward are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Sentryward is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Added

- Automatic approval. With `output.approval.enabled` on (**Approve clean
  reviews** on the Display tab, off by default) a clean review approves the
  PR/MR (a GitHub `APPROVE` review at the head commit, a GitLab approval pinned
  to the head sha), and a later review that is not clean withdraws it
  (GitHub dismisses Sentryward's own approvals, GitLab unapproves). It never
  merges. `when` is `pass` (the verdict passes, as the commit status says) or
  `no_findings`; a partial or failed review never approves. Policies hold an
  approval back: `block_paths` globs (either side of a rename),
  `only_authors` and `skip_authors` (any case), `block_labels` and
  `block_on_risk` (auth, database writes or API routes, found in the diff
  without a model call). `request_changes` requests changes on a blocked
  verdict instead of only withdrawing (GitHub only). The approval is published
  last and independently: a failure marks the review partial, while the forge
  refusing an approval of the account's own change is only a note. The review
  page's sidebar shows the outcome and the reasons, and the Display preview
  returns what would happen. Safeguards: `.sentryward.yaml` (and the trigger)
  can only tighten approval, never turn it on or drop a block (even when a
  dashboard list repeats an entry), and an approval still answers to the
  dashboard's `block_on` (and tool findings blocking) when the repository file
  or trigger loosens them for the review itself, withdrawing rather than
  approving; a repository file or trigger that makes the review report less
  than the dashboard settings (more `ignore_paths`, fewer categories, a higher
  severity floor or confidence, fewer findings or chunks, tool findings off,
  evidence required, or more verification) holds the approval back, with a
  config warning saying which settings; a GitHub approval is not posted (and an
  existing one is not reused) when the head, the base sha or the target branch
  moved during the review, and is dismissed again when they moved while it was
  being posted or could not be re-read afterwards (a failed dismissal is an
  error saying the approval still stands); when the base sha or target branch
  moved, Sentryward's earlier approval is withdrawn too, since a retarget
  queues no new review (a failed withdrawal is an error); a GitLab approval
  gets the same checks, comparing the MR's target branch, diff refs and
  source sha (a push GitLab has not diffed yet counts as moved) before
  an approval is reused or posted and again after, unapproving when they moved
  or cannot be re-read; a skipped run keeps the approval
  only when the last review published an approval decision for the current
  head, base sha and target branch, and otherwise asks the forge to withdraw,
  keeping a GitHub approval of the current head only when the last review saw
  that same head and target and did not decide to withdraw or request changes
  (a failed approval write is recorded with the action it attempted, shown as
  "Failed" in the sidebar; a moved or retargeted base, or no review on
  record, withdraws every approval; filter skips always withdraw, and so does an approval
  policy that holds the change back as it stands now, such as a hold label
  added since the last review); a change whose file list the forge cut short
  is not approved, including when GitLab's legacy `/changes` endpoint reports
  `overflow` without a file count; when `block_labels` is set the forge
  adapter checks it on its own reads of the PR/MR just before and just after
  the write, so a hold label added mid-review or while the approval is posted
  stops or withdraws it (an earlier approval is withdrawn too, whether the
  label is seen before the write or after it, and even when the head moved
  too); a GitLab refusal is only a note when GitLab reports the
  account cannot approve the MR, while other 401/403 errors mark the review
  partial; the preview shows a withdrawal rather than a request for changes on
  GitLab, as publishing does; without its own login (`GITHUB_APP_SLUG` for
  a GitHub App) Sentryward makes no approval decision, since it could not
  withdraw one later; it also makes none on a GitHub token connection or a
  GitLab connection whose token is not a bot user (project or group access
  token, service account), since a person's own approval would look like
  Sentryward's and a withdrawal would remove it; a GitHub base move detected
  after posting dismisses Sentryward's earlier approvals along with the new
  one; and a repository file or trigger that turns approval off while the
  dashboard has it on withdraws an earlier approval (on skipped runs too)
  instead of leaving it in place; retargeting a PR/MR withdraws Sentryward's
  approval from the webhook, even when automatic reviews are off (a GitHub
  request for changes stays, and a failed withdrawal fails the delivery so it
  can be redelivered); a GitHub request for changes gets the same head and
  base checks before and after it is posted as an approval, withdrawing
  Sentryward's earlier approvals rather than posting on commits the review
  never saw, and dismissing the new request along with them when the PR moved
  while it was posted; and an approval (or request for changes) write that
  timed out, dropped or got a server error is checked against the forge, so
  one that landed gets the same freshness checks (a GitLab approval that
  cannot be checked is unapproved). The sidebar shows a request for changes that
  was already standing as "Changes requested", not "Still approved".

- Requirement checks for linked issues. With `output.assess_linked_issues`
  on, the PR summary now splits each linked issue into its concrete
  requirements and shows a table per issue: each requirement marked met,
  partly met, missing or unclear, the changed file and line that meet it, and
  a one-sentence fix for the rest. A file is kept only when the change touches
  it and a line only when the diff shows it. Each missing requirement is also a
  `requirement_gap` finding under "Requirements not met": severity major, so
  it blocks only when `block_on` is `major` or lower, and subject to
  `severity_floor` and `min_confidence` (not `categories`). Gaps are tracked
  across runs by issue and requirement text, not by the file the model names,
  and earlier gaps are passed back to the model so it keeps their wording. A
  gap is resolved only by a run that split its own issue into requirements
  again, or once the change stops linking the issue; a failed summary, an
  unreadable tracker, a skipped issue or a run that hit `max_findings` leaves
  it open. Gaps are not promoted to the branch backlog on merge, and a
  requirement is never placed in a file `ignore_paths` excludes. Statuses like
  "not met" or "done" are read as missing or met. Gaps placed in no changed
  file show "Linked issue" instead of a path, on the backlog page too. The
  review page's walkthrough card lists the requirements, and results stored
  before this change still render as before.

- Pause on a burst of pushes. `triggers.pause_on_burst` (**Pause after a burst
  of pushes** on the Triggers tab, off by default) stops automatic push reviews
  of a change once it receives `pause_after_pushes` pushes (default 5) within
  `pause_window_minutes` (default 15). The change stays paused until someone
  comments `/sentryward review` or starts a review from the dashboard, after
  which pushes are counted again. A request that was skipped (review commands
  off) or cancelled does not end the pause. A request made while a push for
  the same commit is queued or running is recorded on that push, which then
  answers it: the pause never skips it, even when it is the push that would
  start the pause, and the commit is reviewed once. Pushes are counted by
  distinct commit, so forge redeliveries count once; pushes skipped for another
  reason (a draft, review on push off, filters) do not count. A pause is
  forgotten once a later push was reviewed (for example, with the setting
  turned off meanwhile), and retention never brings back a pause a request
  ended. A paused push is recorded as skipped with the reason, and the
  Triggers summary shows the limits.

- Coding-agent instruction files as review guidance. `review.agent_files.enabled`
  (**Coding-agent instruction files** on the Guidance tab) shows every review
  pass the `CLAUDE.md` and `AGENTS.md` files from the repository root and the
  folders of changed files, plus `.cursorrules`, `.github/copilot-instructions.md`
  and the `.cursor/rules/**/*.mdc` rules that apply to the change. They are read
  from the base revision, wrapped as untrusted, ranked below the team rules and
  never block a review. `review.agent_files.max_chars` caps their total per pass
  (8000 by default, nearest folder first); files left out, cut or unreadable are
  warnings. Cursor globs work as in Cursor (unquoted, comma-separated with
  brace sets such as `**/*.{ts,tsx}` kept whole, and slashless globs match at
  any depth, with a quoted `alwaysApply: "true"` honoured); up to 30 rules are checked and at most 10 that apply
  are used, from at most 8 rule folders; rules or folders past their caps are warnings. Glob lists
  are read even when a rule's frontmatter is not valid YAML, and a rule whose globs cannot be read
  is a warning. At most 12 folders are checked, preferring those above the most reviewed files, so
  a package-level `CLAUDE.md` is not crowded out by deeply nested ones; the warning names the folders
  skipped. A symlinked `AGENTS.md` is followed on GitLab as on GitHub, even when its target is also
  read on its own. An incremental review uses
  only the instruction files for the files it reviews again, and files the
  review leaves out (pure renames, withheld patches, files moved into an ignored path) do not pick folders or
  match rules. A push after an instruction file changed on the base branch gets a full review, since
  carried findings were made under the old guidance. Reviews stored before the setting existed still allow an
  incremental review. Off by default. The review result lists the files used
  (`agentFiles`) and the review page's sidebar shows them.

- Auto deep review. `review.deep.enabled: auto` (Deep review > Auto on the
  Finding Types tab) runs the specialist passes only when the reviewed files
  touch authorization, database writes or API routes, as found by the existing
  risky-area detection, so low-risk changes skip the extra model calls. Files
  or hunks left out of the review for size or budget do not count, and when
  auto decides against a deep review the change is planned for the general pass
  alone, so the specialists' longer prompts never leave a hunk out. Risky code
  that fits only that general-lens plan still gets a standard review, and the
  result, a warning and the sidebar say so instead of reporting no risk.
  `review.deep.auto_on` picks which of those kinds count (all three by default).
  An incremental review decides on the files it reviews again, and a run that
  asks for a deep review still gets one. The review result records the decision
  (`deepAuto`) and the review page's sidebar shows it.

- Resizable file tree on the review page. At `lg` and up, a handle between the
  tree and the diff drags the tree column between 12rem and the smaller of 32rem
  and 40% of the viewport; it is a focusable separator (arrow keys step 1rem,
  Shift 4rem, Home/End jump to the bounds) and a double-click resets it to 15rem.
  The chosen width is remembered across reviews and reloads (#301).

- Global Expand all / Collapse all controls on the review Overview. Walkthrough
  sections and findings start collapsed, and the last global choice is remembered
  across reviews and reloads. Individual toggles and the findings toolbar remain
  local to the current view (#302).

- Custom reviewers (`reviewers`). A team defines extra reviewers with a name,
  instructions, optional file globs (`paths`), severity floor and finding limit
  (`max_findings`), in the global, repository or folder settings (new editor on
  the Guidance tab) or `.sentryward.yaml`. Like rules they combine across
  layers: a layer adds reviewers and an id already set below is ignored with a
  warning, and saves that would leave one out are refused under `reviewers`
  (approving a rule suggestion into a repository is refused only for rule
  problems, not for a reviewer clash it did not cause).
  Every enabled reviewer gets one pass per planned chunk holding a file it
  covers, its instructions in place of the team rules; its findings carry
  `reviewer` and `reviewerName`, are tagged `· reviewer <name>` in forge
  comments and "Reviewer: <name>" on the review page, skip the category
  filter, are dropped as `reviewer_mismatch` on files outside its paths, and
  are capped per reviewer before `max_findings` (a finding the general pass
  also reported, or one an incremental review carries over, is not counted
  against the reviewer's limit). Adding,
  removing or changing a reviewer makes the next push a full review. A failed
  reviewer pass is a warning. The review sidebar lists the custom reviewers
  that ran.
- Trial runs of a custom reviewer: `POST /api/reviews/trial` (owners and
  admins; by URL, or repository and number) queues a review that runs the
  draft in place of the saved custom reviewers (`review_jobs.trial`,
  `review_jobs.trial_reviewer`), which skips the
  walkthrough and posts, syncs and notifies nothing. Trials never supersede,
  answer or block the change's reviews, are not an incremental base, a
  previous verdict or the backlog's source, and are left out of the change
  view and review stats, benchmarks, a connection's recent reviews, the
  failed-reviews badge, the blocked digest, each repository's last review, the
  webhook's per-repository queue cap, and the backlog's merge and sweep waits;
  a trial's progress shows no publishing step; retention
  never keeps a trial as a change's newest run, nor trims a real review
  because a trial ran after it. Re-running one tries the same draft. The config a
  trial stores keeps only the draft's id and name, since every member can
  read it. A trial queued while its repository is being turned off is refused
  (409) rather than left queued, and one queued as its change closes is
  cancelled with the change's other queued jobs.

- Deep review (`review.deep`). Off by default; when on, every review pass of a
  change is reviewed again by up to seven specialists (`naming`,
  `invariants`, `boundaries`, `contracts`, `tests`, `leaks`, `consistency`),
  each told to look for one kind of defect only, each adding one review pass
  per planned chunk (more than one model call with agentic context). Settable at every config layer (`review.deep.enabled`,
  `review.deep.specialists`), on the Finding Types tab, or for one run with
  `/sentryward review deep` or the **Deep review** switch in the manual review
  sheet (stored on the job as `review_jobs.deep`, kept by re-runs). Specialist
  findings are tagged with the specialist (`reviewer`) and their calls with
  `lens` in usage; they skip the category filter like rule findings, never
  carry team rules (those stay with the general pass), and a failed
  specialist pass is a warning rather than a partial review. Findings from a
  specialist pass whose general pass on the same part of the change failed
  are dropped, and a warning says how many; a file split across passes keeps
  what was found in the parts whose general pass succeeded. In agentic mode specialists leave half of
  `review.agent.maxSearches` to the general passes. `/sentryward review
  deep-dive ...` is not read as a deep review request. A specialist's
  rewording of a general finding (same file, category and overlapping lines,
  with titles sharing at least half their words) is merged as a duplicate;
  reports from the same pass never are. The review page tags each finding
  with its specialist and shows how many ran. The eval runner gains `--deep`
  (and `--compare --deep`) with per-specialist hits, false positives and
  cost, and two new cases (`ts-hollow-discount-test`,
  `ts-renamed-status-value`).
- Rule suggestions learned from review history. Off by default; owners and
  admins turn it on from the new **Rule suggestions** page (Workspace). While
  on, comments people with push access leave on changed lines are stored
  (on GitHub, checked against the commenter's repository role, so a
  read-only or triage collaborator's comments are not kept)
  (`review_comments`) from the GitHub and GitLab webhooks already received,
  skipping bots (on GitLab, whose webhook does not mark them, access token
  users and service accounts are recognised by the users API's bot flag,
  asked only for a comment that would otherwise be kept), commands,
  Sentryward's own threads (recognised by the thread
  root's marker when the posted-comment record no longer names it),
  excluded reviewers and comments not anchored to a current new-side line
  (outdated comments, GitLab notes on removed lines), which are skipped before
  the commenter's permissions are looked up. A comment is stored with the
  forge's authoring time (clamped to now), not its delivery time, so a late or
  redelivered comment ages from when it was written; one already past the
  90-day history window or the workspace's retention period is not stored at
  all. The opt-in and exclusions are checked again under a lock
  on the workspace just before a comment is stored, so a comment arriving while
  the feature is turned off is never kept. The excluded-reviewers list
  (`workspaces.rule_suggestions_excluded_reviewers`) is `NOT NULL`, so a
  `NULL` written outside the app is refused instead of crashing comment
  storage or the settings page. A diff comment that cannot be stored for a
  reason a retry could fix (a permission lookup the forge failed, a database
  error) fails the webhook delivery with a 500 after any reply handling has
  run, on GitHub (a reply in a person's own thread included) and GitLab alike,
  so it shows as failed and can be redelivered. One that would fail the same
  way every time (a value the database refuses, a permission lookup the
  connection may not make) is logged and the delivery succeeds, so GitLab does
  not disable the hook, and automatic reviews with it, over a comment that can
  never be kept. NUL characters are removed from a comment and its path
  before storing, as Postgres text cannot hold them.
  Once a week per workspace (or on **Check now**, at most hourly, counted from
  the request as well as the last run so a queued check cannot be requested
  again; `workspaces.rule_suggestions_requested_at`) the worker
  groups the last 90 days (or the workspace's privacy retention period, when
  shorter) of comments and false-positive or intentional dismissals, and when
  something recurs across at least two changes and the
  minimum evidence, asks the workspace's review model for at most five rules
  (audited as `rule_suggest`, privacy restrictions applied). Drafts with an
  invalid rule, a taken id (including any discarded suggestion's), a likeness
  to any discarded suggestion under a new id (the same pattern, an id whose
  words all appear in the other's, or a near-identical first sentence) or too
  little evidence are dropped. The prompt lists the 100 most recently
  discarded rules by their first sentence; the likeness check covers every
  one. Each
  comment or dismissal backs one suggestion at most. Suggestions wait for an
  admin, who can edit one and approve it into the global settings or a
  repository's own settings through the same checks as a manual save, or
  discard it. Approving into the global settings is refused (`rule.id` field
  error) when the rule would take the id of a repository or folder rule, which
  global rules would silently replace; repositories already left out by the
  global rules stay a config page warning and do not block it. New endpoints under `/api/rule-suggestions` (`/counts` feeds the
  nav badge without loading the list); review comments and the suggestion
  excerpts quoting them are deleted after 90 days, by privacy retention, and
  when the feature is turned off, and an excluded reviewer's go with them.
  Each excerpt expires by the age of the comment or dismissal it quotes, not
  the suggestion's, and the retention log counts each excerpt trimmed (not
  each suggestion touched), including for workspaces without a privacy period.
  A run saves its suggestions only after re-reading the opt-in under the same
  workspace lock, so turning the feature off or excluding a reviewer while the
  model is answering never brings back deleted comments: a run turned off
  mid-call saves nothing, and a suggestion citing a comment deleted meanwhile
  is dropped. A run also re-checks that the feature is still on, and that its
  claim has not been replaced, just before the model call and every 15 seconds
  while it runs, so a run turned off after it was claimed makes no billed
  request, or has its request (and fallbacks) aborted. Each claim carries a
  run token (`workspaces.rule_suggestions_run_token`) that turning the feature
  off clears, so a run stays stopped even when the feature is turned back on
  before it checks again. Before saving, a run also locks every comment and dismissal it
  cites, so retention cannot delete one until the suggestion is stored, and
  drops any suggestion whose evidence is gone, no longer dismissed, or already
  past the retention cutoff in force at save time (a period shortened during
  the model call applies too), so no excerpt outlives what it quotes.
  Drafts are validated under that same lock, against the evidence minimum and
  the rule ids taken at that moment, so a minimum raised or a rule approved
  under the drafted id while the model is answering drops the draft.
  The list (`GET /api/rule-suggestions`) is paged, 100 at a time, newest
  first: pass the returned `nextCursor` as `?cursor=` for the next page, and
  the page offers **Load more**. A cursor whose timestamp is out of range is
  refused with a 400. A page holds only suggestions still in the
  requested status; one decided while the page loads is left out. Worker shutdown waits for a running suggestion pass before
  disconnecting from the database.
  Removing a repository deletes its pending suggestions, and removes its
  excerpts and cited comment and dismissal ids from other suggestions. Excerpts
  record their repository's id and are matched by it, so a repository renamed
  after drafting does not leave its excerpts behind under its old name; older
  excerpts without the id go when their name is the repository's or matches no
  other repository in the workspace. The page leads with the suggestions: settings fold into a header showing
  whether learning is on, the last check and **Check now** (open by default only
  while off). Cards carry the rule's severity colour, the rationale and a
  foldable evidence summary. Discarding asks for confirmation, and approving into
  a repository that follows the global settings offers the global settings
  instead.
- Folder settings for monorepos. On the Review settings page a repository can
  have folders (`repositories.directories`) with settings of their own, edited
  like the repository's and inheriting from them. A review uses a folder only
  when every file the change touches (ignored files aside) is inside it;
  otherwise the repository settings apply. The folder layer sits between the
  repository settings and `.sentryward.yaml`, can only add rules (held like
  other dashboard rules), and is ignored while the repository follows the
  global config. Folders cannot be inside one another. The folder a review
  used is stored in `resolvedConfig.directory` and shown on the review page,
  and replies to a finding follow it. Folders are added, saved and removed one
  at a time (`POST`, `PUT` and `DELETE /api/repos/:id/directories`), merged
  into the saved list under a row lock, so editing one folder never drops
  another added since the page loaded, and only the folder being saved is
  checked. Saving repository settings is refused when it would make a saved
  folder's rules be ignored (a folder that was already broken is not held
  against the save). `GET /api/repos/:id/config` takes `?directory=` (404 for a folder
  that is not saved) and then also returns `inherited`, which the folder form
  checks rules against. A webhook close cancels queued reviews only when the
  repository and every folder keep `abort_on_close`, and a folder that
  disables the cache gets fresh reads from the first one.
- Monthly spend alerts. Workspace admins can set a monthly budget in USD
  (`workspaces.monthly_budget_usd`) under **Prices and budget** on the LLM
  Connections page (the tab was **Model prices**). It only notifies: reviews
  never stop over it. The worker checks every 5 minutes (50 workspaces per
  poll, 4 at a time, so a large scan never holds up reviews or notification
  deliveries) and alerts when the
  UTC month's estimated review spend (the same figures as the Usage page)
  reaches 50, 75, 90 and 100% of the budget, and when it passes 110% (over
  budget), each at most once a month (`budget_alerts`, a new table, records
  the alerts sent). Thresholds crossed together send one alert, for the
  highest; changing the budget re-arms the month's thresholds it no longer
  reaches, so raising it mid-month does not silence the rest. Alerts go
  to workspace targets with the new **Budget** event (`budget` in
  `notification_event`; personal targets don't offer it), at once whatever
  the target's scope or digest schedule, through the usual outbox, and by email
  to owners and admins when mail is configured (even when an email target
  with the event also reaches them, since that target can be paused or fail). The admin email is queued in the same
  transaction as the alert record (`admin_user_ids`, `admin_email_payload`,
  `admin_email_attempts` and `admin_email_locked_at` on `budget_alerts`;
  `admin_user_ids` is `NOT NULL`, since the email claim never matches a NULL
  recipient list), so a
  worker restart or SMTP failure cannot lose it: anyone whose email failed is
  retried 5 minutes later, up to 5 attempts, until the month ends, and
  only while still an owner or admin. Webhooks get a `budget` body with the month,
  threshold, spend, budget and unpriced calls; Slack, Google Chat, Discord,
  Teams and email get a short message with a **View usage** link. A budget can
  only be switched on once every model used in the last 90 days has a price;
  that check and deleting a model price take the same workspace row lock, so a
  price deleted while a budget is being switched on cannot slip past it.
  The budget card shows this month's spend against the budget, the alerts sent,
  the models still unpriced and a warning when no target listens. The Usage
  page shows the same meter when a budget is set. New endpoints:
  `GET /api/settings/budget` and `PUT /api/settings/budget` (admins).
  Retention deletes alert records after 400 days. The month's spend is summed
  in the database, so a check reads one row however many reviews ran, and
  admin emails are sent 10 per worker poll, so a pile of them never holds up
  reviews or deliveries. The check's lock on the workspace row no longer
  blocks (or skips the check because of) inserts that reference the
  workspace, such as a running review's request logs. A target that listens
  only for budget alerts is not paused when its repositories are deleted,
  since repository scope does not apply to it. The models used in the last 90
  days (for the budget card and the Prices tab) are listed in the database
  rather than by loading every recent review's summary.
- A backlog of findings that shipped. When a pull or merge request merges,
  its findings that were still open, or ignored as "fix later", become
  repository-level backlog items (`backlog_items`, a new table) that outlive
  the change's own findings. A change closed without merging adds nothing.
  At the same merge, earlier open items on the branch it merged into are
  resolved from the change's latest stored review: fixed when the review read
  the file, the diff removed or rewrote one of the item's lines (or inserted
  between them) and the finding was not reported again; invalidated when the
  file was deleted or renamed. A resolved item that ships again reopens; a
  dismissed one stays dismissed, even when it is dismissed while the merge is
  being processed. Nothing is marked fixed when the review cut findings over
  `review.maxFindings`, reported a finding on the same lines, or the finding
  was ignored on that change. Merges are recorded from the GitHub and GitLab
  close webhooks (now acted on whatever `abortOnClose` says), from a review
  that sees its change merge while it runs (whatever `abortOnClose` says),
  and from a worker sweep that asks the forge about quiet changes with
  unaddressed findings every few hours, so a missed webhook is caught before
  retention purges the findings (`change_states`, a new table, records what
  is known). The worker applies recorded merges, oldest first, once no review
  of the change is queued or running, so webhooks stay fast and a review still
  running at merge time has its findings counted; a merge applied late is
  replayed against later merges into the same branch. A merge first seen
  without a merge time (by a running review, or a GitLab webhook) takes the
  forge's time, and a missing target branch, from a later webhook or sweep. A new **Backlog** page lists items with filters for state,
  origin, severity, category, type, age and repository, a stats strip (open
  items by severity and age, for the selected repository), and dismiss (with an optional note) and reopen
  actions, backed by `GET /api/backlog`, `GET /api/backlog/stats`,
  `GET /api/backlog/:id` and `PATCH /api/backlog/:id`. Retention deletes
  items resolved longer ago than the period and open items neither merged nor
  seen within it, and scrubs items dismissed longer ago (text cleared, hidden
  from the API) so the dismissal still holds. It holds back purging a change's
  unaddressed findings until the sweep has asked the forge whether it merged
  (unless the repository is turned off or its access is gone) and until a
  recorded merge is applied, and keeps a change's merged state, so a worker
  outage longer than the period loses no merges and none is applied twice.
- A focus for a single review: `/sentryward review focus on <area>` (or
  `focus: <area>`) asks that run to look hardest at the area named, while
  still reporting real problems elsewhere. The rest of the command's line is
  used, trimmed and capped at 300 characters. The dashboard's manual review
  sheet has an optional Focus field, and `POST /api/reviews` takes an
  optional `focus`; either way whitespace is collapsed and the cap counts
  characters, so an emoji is never split. It is stored on the job
  (`review_jobs.focus`, a new nullable column), never in settings, and
  retention keeps it, so a re-run asks the same question. It reaches the
  review passes as untrusted text in the user prompt (not the verifier or
  walkthrough), and only a review with a focus spends prompt budget on it.
  It is recorded as `result.focus`, and the summary comment shows it as a
  plain-text "Focus" line (links, images and emphasis are escaped), on a
  clean pass too. A request without a focus reuses a queued or running
  review of the same head, focused or not; a request with a different focus
  supersedes a queued one (the last of two focuses wins) or waits behind a
  running one. The review page's sidebar shows the focus.
- A file tree and per-file diffs on the review page. The changed files are
  listed as a tree on the left (single-child directories folded, each file
  with its line counts and a badge for its findings), and the first file's
  diff opens by default, with each finding shown under the last line it
  covers and findings off the diff listed above it. The walkthrough and the
  full findings list move to an Overview entry at the top of the tree, and
  a finding's path there opens its diff. The selection is kept in the URL
  (`?path=` or `?view=overview`). Below the `lg` breakpoint the tree opens
  in a sheet. Reviews now store each file's patch in their result (up to
  200,000 characters per file and 2,000,000 per review; a file over either
  limit, a binary file or a diff the forge withheld is listed with the
  reason instead), so the page shows the revision that was reviewed and
  retention clears it with the rest of the result. The tree and diffs show
  for every status: a review with no diffs stored (results from before they
  were kept, and queued, running, skipped, failed, cancelled, superseded or
  expired runs) reads them from the forge through the new
  `GET /api/reviews/:id/diff`, pinned to the reviewed commits when the job
  recorded its base, under the same limits and never written back. A queued
  or running review opens on its progress; any other opens its first file
  with its notes, or the reason it did not run, above the diff.
- Who opened a PR/MR and its dates on the review page. The header names the
  author ("opened by @user · 2 days ago"), and the sidebar's Change card
  shows the change's state (Open, Draft, Merged or Closed), when it was
  opened and last updated, and when and by whom it was merged or closed.
  Both also show the source and target branch (a GitHub fork's source as
  `owner:branch`), falling back to the branches the review recorded, and
  the sidebar's branch rows replace its old `base ← head` line.
  They are read live from the forge through the new
  `GET /api/reviews/:id/change`, so a merge after the review shows up, and
  the rest of the page still renders when the forge cannot be reached.
- Claim checks (`review.check_claims`, on by default). A finding may name the
  fact it rests on: a path that does not exist, a symbol nothing references,
  or a file nothing imports. Before verification, the claim is looked up at
  the head revision (a file read, the change's own added lines, then at most
  5 code searches, taken from the review's shared `review.agent.max_searches`
  budget, and 15 reads per review) and the finding is dropped as
  `claim_refuted` when the repository contradicts it. A search hit counts
  only once it is confirmed by reading the file at the head, since GitHub
  searches the default branch. Only an unambiguous reference refutes: a use
  of a symbol in another file counts only when that file imports the
  finding's file, property accesses, strings, docs and other declarations of
  the name are not uses, a file counts as referenced only by an import or
  path that resolves to it, and a path relative to the finding's file must
  exist under every reading (an empty file exists). Absence, errors, a
  failed check and a spent budget never drop anything. `review.max_findings`
  applies after the check, so a dropped finding frees its slot. No model call
  is made; the claim is only requested in the prompt and the output schema
  while the setting is on, and of two duplicate findings the merged one keeps
  a claim only if both made one. The dashboard's Accuracy section has the
  toggle, the "Checking findings" step now also covers claim checks,
  and the review sidebar names the new drop reason. A new eval case,
  `ts-clean-audit-import`, covers an import of an untouched module.
- Discord and Microsoft Teams notification targets (#259). A new `discord`
  target kind takes a channel's webhook URL (the form labels it **Webhook
  URL**) and posts one embed: the headline
  with its emoji, the repository and number, the title, the findings by
  severity or a failed review's error, and **View review** and **Open PR/MR**
  links (the second only for an http(s) change URL short enough to send).
  Forge text is escaped so it cannot add formatting, a link or a mention, and
  the message allows no mentions. A new `teams` kind takes a Workflows
  webhook URL (labelled **Workflows webhook URL**, not the retired incoming
  webhook connectors) and posts one Adaptive Card with the same content and **View
  review** and **Open PR/MR** actions; forge text goes only into text runs,
  which render no markdown, with its URLs broken up. A digest is one embed or
  card with the counts, the most blocked repositories, up to 10 still-blocked
  changes and 5 failed reviews, each row in Teams with its own **View
  review** button; Discord's shows fewer rows and counts the
  rest when they would pass its embed limit, and both stay inside the
  service's message size limit. A `404` Unknown Webhook (code
  `10015`) from `discord.com` or `discordapp.com` pauses a Discord target at
  once, while any other `404` (such as a deleted thread named by
  `?thread_id=`) counts as an ordinary failure; a
  Teams workflow has no such answer, so its target pauses by the failure
  count. `Retry-After` may be a fraction of a second, as Discord sends; a retry
  after a `429` waits at least 5 seconds. Both
  URLs are stored encrypted, only the host is shown, and the token or
  signature is cut out of stored errors (the fixed words of the URL, such as
  `workflows` or `webhooks`, are kept). Adds the `discord` and `teams`
  values to the `notification_kind` enum (migration
  `20261113090300_notification_kind_discord_teams`).
- Google Chat notification targets (#283). A new `google_chat` target kind
  takes a space's incoming-webhook URL and posts a card: the headline with
  its emoji, the repository and number, the title, the findings by severity
  or a failed review's error, and **View review** and **Open PR/MR** buttons
  (the second only for an http(s) change URL). A digest is one card with the
  counts, the most blocked repositories, up to 10 still-blocked changes and 5
  failed reviews (title and error clipped separately, so a long title
  cannot hide the reason), kept inside Google Chat's message size limit.
  Forge text is escaped in the card, a URL in it is broken up with zero-width
  spaces so it is not linked, and it is kept out of the message's
  `fallbackText` (the notification text; there is no `text`, which would
  repeat the card's header). A `404` from `chat.googleapis.com` (a deleted
  webhook or space) pauses the target at once, like Slack's; a `404` from any
  other host, and retries and auto-pause otherwise, work as for any target.
  Clipped text (email and Slack included) no longer ends in half an emoji. The URL is stored
  encrypted, only its host is shown, and its `key` and `token` are cut out of
  stored errors. Adds the `google_chat` value to the `notification_kind`
  enum (migration `20261113090200_notification_kind_google_chat`).
- Personal notifications (#258). Any member can switch on email about reviews
  of the pull and merge requests they opened, from the **My email** tab on
  the Notifications page (`?tab=personal`), which lists what is missing
  (mail, a linked forge account) as steps
  (`GET`/`PUT /api/notifications/personal`),
  choosing blocked, failed, resolved and completed. A change is matched to a
  member through the forge user id of its author, recorded on the review job
  (`author_id`) when a webhook queues the review and again when the worker
  fetches the change, against a GitHub or
  GitLab sign-in identity the member linked on the same host; the card points
  to Sign-in methods for any host without one. Personal targets go through
  the same outbox, are hidden from the workspace's targets and from admins,
  are deleted when the member leaves the workspace, and are skipped for a
  review a workspace email target already sends that member right away (a
  digest does not count). An auto-paused personal target emails its member,
  not the admins, and only switching it back on clears the pause notice.
  Reviews where the member is a requested reviewer are not covered yet.
- Notification URLs can be edited and webhook secrets rotated in place
  (#257). `PATCH /api/notifications/:id` accepts `url` for webhook and Slack
  targets, checked like a new target's, keeping events, scope, secret and
  history and starting the failure count again; the edit panel has a URL
  field showing the current host. `POST
  /api/notifications/:id/rotate-secret` (admins, webhooks) returns a new
  secret once, from **Rotate secret** in the target's menu (a rotation that
  races another is refused with `409`). For 24 hours the
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
- API callers that save settings must now send the revision they read:
  `revision` (from `GET /api/config/global`) on `PUT /api/config/global`, and
  `settingsRevision` (from `GET /api/repos`) on a `PATCH /api/repos/:id` that
  sends `settings`. Saves without one are refused with a 409 asking to reload
  the page (what a settings page loaded before upgrading shows when it saves).

### Changed

- Replies on Sentryward's GitHub inline threads (questions and
  `/sentryward ignore`) now require push access by the commenter's
  repository role (admin, maintain or write) instead of their author
  association, which counts read-only and triage collaborators as
  collaborators. This matches GitLab, which already required Developer.

- A committable suggestion that repeats the lines it would replace is
  removed before publishing, along with its fix rationale; the finding is
  kept and its body carries the fix. The comparison is of what applying it
  would change: only the final newline and line endings are ignored, so a
  suggestion that adds or removes blank lines, trailing whitespace or
  indentation is kept. A suggestion on lines outside the diff
  (`review.full_file`) is kept since there is nothing to compare it with.
  When two reports of one finding merge, the kept one takes its twin's
  suggestion for the same lines if it has none of its own. How many
  published findings lost a suggestion this way is stored with the result
  (`validation.noopSuggestions`; findings later dropped as duplicates,
  dismissed, refuted or over the cap are not counted) and totalled by
  `npm run eval`, including in `--compare` runs.
- A review that passes with no findings at all now posts a short summary
  comment: "🎉 Congratulations, no findings at or above `<block_on>`. 🎉"
  followed only by the footer. The walkthrough, verdict line, finding counts,
  lifecycle ("Since the last review"), coverage, notes and the review stats
  line are left out. The same output is served by `GET /api/reviews/:id/markdown`. A
  pass that still has findings below the threshold keeps the full summary.
- The in-progress summary comment is now a loading state only: an animated
  badge (spinner, "Reviewing changes", pulsing dots and a shimmer track,
  light/dark aware and still under reduced motion), a "Reviewing `<sha>` ·
  results will replace this comment" line and the live progress link. The
  file count and `+/-` line stats, and the "Walkthrough and summary appear
  here · Findings land inline · status" line are gone. The badge is the new
  `client/public/sentryward-reviewing.svg`; `sentryward-progress.svg` stays
  for comments already posted.
- The Model and Rule tables in the false-positive breakdown on the Findings
  page are paginated (#303), each with its own page and page size in the URL
  (`?fpModelPage=`, `?fpRulePage=`), apart from the false-positive list's.
  Pages hold only the rows with enough findings to show; the "rows with fewer
  than 5 findings hidden" note still counts the whole set. Picking or clearing
  a repository starts both tables over at page 1. Category and Severity stay
  unpaginated, since they always fit the smallest page.
- The Models, Best model and Repositories tables on the Benchmarks page are
  paginated (#276), each with its own page and page size in the URL
  (`?modelsPage=`, `?bestPage=`, `?reposPage=`). Best model pages by model
  row, naming a language or category again at the top of a page it runs
  onto, and keeps its grouping in the URL too (`?bestGroup=category`), so a
  reloaded or shared link opens on the same list. Changing the period or
  repository starts every table over at page 1, with the old figures dimmed
  until the new ones load, and switching between languages and categories
  does the same for Best model. The controls only show under a table with
  more than ten rows.
- The Confidence calibration card on the Findings page's False positives tab
  paginates its groups when grouped by model or category (#304), with its own
  page and page size in the URL (`?calibPage=`, `?calibSize=`), apart from the
  false-positive list's. A page holds whole groups, so a group's heading and
  table never split across pages. Changing the grouping or picking or clearing
  a repository starts it over at page 1. No grouping keeps its single table
  without controls, and the loading, error and empty states show none either.
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

- An invalid **Max inline comments** value marks the Display tab with an error,
  as other fields do, instead of disabling save with no tab showing why.
- Saving the global config or a repository's settings from a page loaded
  before someone else changed them (another admin's save, or an approved rule
  suggestion) is refused with "changed since the page loaded; reload and try
  again", instead of silently replacing their changes with the stale copy.
  `GET`/`PUT /api/config/global` return a `revision` and the repository list
  a `settingsRevision`, derived from the saved settings, and a save must send
  them back: `PUT /api/config/global` requires `revision`, and
  `PATCH /api/repos/:id` requires `settingsRevision` whenever it sends
  `settings` (a 409 asking to reload otherwise), so no save can replace a rule approved since
  its settings were read.
- On GitHub, `/sentryward review` now requires push access to the repository,
  checked by the commenter's repository role, as for thread replies. A comment's
  author association does not tell read and triage collaborators from writers,
  so they could previously start a review billed to the workspace. A
  connection that may not read the commenter's role refuses the command
  (`not_allowed`); a rate limit or forge outage fails the delivery with a 500
  so it can be redelivered.
- Saving a repository's settings or a folder checks its rules against the
  global settings read under a lock on the workspace, the one approvals and
  global saves take, so a global rule added at the same moment can no longer
  slip past the check and silently replace a repository or folder rule.
- Switching a repository from the global settings to its own now takes that
  same workspace lock and checks its saved rules against the global settings,
  as saving them would. A global rule approved at the same moment could
  previously see the repository as still following the global settings and
  silently replace one of its rules.
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
