# Release handoff

## 0.3.0 preparation (2026-10-31)

Release metadata is prepared for `v0.3.0`. Both package manifests and
lockfile root entries use `0.3.0`, and the production env example and README
pin it. The changelog's `0.3.0` section has the release notes, upgrade notes
and comparison link. The production Compose file now runs the server and
worker under an init process and passes `REVIEW_RETENTION_DAYS` to the worker.

### Verification

- Server: 1276 tests pass, type check passes, and Prisma schema validation passes.
- Client: 518 tests pass with `--maxWorkers=2`; type check, lint and production
  build pass. Lint reports the same two Fast Refresh warnings in
  `AuthProvider.tsx` as 0.2.0, and the build reports the same chunk-size warning.
- The production Compose file renders with `.env.production.example` (and
  placeholder secrets), using image `ghcr.io/rdlugs/sentryward:0.3.0`.
- Dependency audits: server reported one high runtime finding, zod below 4.6.6
  ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5));
  `npm audit fix` moved zod to 4.6.7, and the server now reports zero findings
  with and without dev dependencies (tests and type check rerun). Client reports zero
  runtime findings and eight in development tooling (one high, five moderate,
  two low), all outside the browser bundle.
- Not performed: a production image build, an upgrade from
  a 0.2.0 database, a browser walkthrough, a live forge/model review, or hosted
  CI on the preparation commit.

### Publication steps

- [ ] Authorize staging and committing the preparation changes.
- [ ] Push the approved commit and obtain passing hosted CI for it.
- [ ] Create and push `v0.3.0` on that verified commit.
- [ ] Verify both architecture images are published to GHCR and `latest` moved.
- [ ] Publish a stable GitHub release using the `0.3.0` changelog section,
  including its upgrade notes.

## 0.2.0 preparation (2026-10-22)

Release metadata is prepared for `v0.2.0`. Both package manifests and
lockfile root entries use `0.2.0`, and the production env example and README
pin it. The changelog's `0.2.0` section has the release notes, upgrade notes
and comparison link. The production Compose file now passes
`WORKER_HEARTBEAT_INTERVAL_MS` and `WORKER_MAX_RUN_MS` to the worker, which it
did not before.

### Verification

- Server: 836 tests pass, type check passes, and Prisma schema validation passes.
- Client: 286 tests pass with `--maxWorkers=2`; type check, lint and production
  build pass. Lint reports the same two Fast Refresh warnings in
  `AuthProvider.tsx` as 0.1.0, and the build reports the same chunk-size warning.
- The production Compose file renders with `.env.production.example`, using
  image `ghcr.io/rdlugs/sentryward:0.2.0` and the new worker settings.
- Dependency audits: server reports zero findings with and without dev
  dependencies. Client reports zero runtime findings and the same seven high
  findings in shadcn development tooling accepted since alpha.
- Not performed: a production image build, an upgrade from a 0.1.0 database, a
  browser walkthrough, a live forge/model review, or hosted CI on the
  preparation commit.

### Publication steps

- [ ] Authorize staging and committing the preparation changes.
- [ ] Push the approved commit and obtain passing hosted CI for it.
- [ ] Create and push `v0.2.0` on that verified commit.
- [ ] Verify both architecture images are published to GHCR and `latest` moved.
- [ ] Add the Checks (read) permission and the Pull request review comment event
  to the public GitHub App, if one is published.
- [ ] Publish a stable GitHub release using the `0.2.0` changelog section,
  including its upgrade notes.

## 0.1.0 preparation (2026-10-13)

Release metadata is prepared for `v0.1.0`. Both package manifests and
lockfile root entries use `0.1.0`; the production env example pins this
version for controlled upgrades. This is the first stable release; the image
workflow publishes both `0.1.0` and `latest`. The changelog contains the release
notes and comparison links.

### Verification

- Server: 559 tests pass, type check passes, and Prisma schema validation passes.
- Client: type check, lint and production build pass. Lint reports two existing
  Fast Refresh warnings in `AuthProvider.tsx`; the build reports one existing
  diagram chunk above 500 kB.
- Client: all 243 tests pass with `docker compose exec -T client npm test --
  --maxWorkers=2`. The default worker count produced timing failures (five on
  the first run, one five-second timeout on the second) on this host; limiting
  workers resolved them without changing application code or test timeouts.
- Dependency audits: server reports zero findings with and without dev
  dependencies; client reports zero runtime findings and the same seven high
  findings in shadcn development tooling previously accepted for alpha (see the
  historical audit below). These remain disclosed for the stable release.
  Installed KaTeX is `0.18.10`, covered by the Mermaid override.
- Before changing release metadata to stable `0.1.0`, the production image built
  from locked dependencies on this host using `0.1.0-alpha.3` metadata. A separate
  Compose project with a fresh database applies migrations and starts the API
  and worker. API health, dashboard HTML, a deep SPA route, unknown API 404, and
  non-root runtime checks pass. The API binds to loopback and the database has
  no published host port. The disposable production services, volume and env
  file were removed after verification.
- Hosted CI passes for source commit `e0d3ae37389291a6f0b415864a5669f2331b699d`
  ([run 38351600077](https://github.com/rdlugs/sentryward/actions/runs/38351600077)).
  CodeQL also passes for that commit. Hosted CI must also pass on the release
  preparation commit before tagging.
- No browser walkthrough, live forge/model review, public deployment, new secret
  scan, or local arm64 build was performed for this preparation. The release
  workflow builds both amd64 and arm64 images when the tag is pushed.

### Upgrade notes

- Back up the database and encryption key before upgrading. Preserve the key.
- This release renames Bammy identifiers with no compatibility fallbacks. Follow
  the changelog's config filename, command, status, cookie and volume notes.
  Preserve an existing database explicitly when switching Compose project names;
  the new project otherwise creates an empty volume.
- Existing user data moves into personal workspaces through startup migrations.
  The oldest existing account becomes the instance admin.
- Use the production Compose file behind an HTTPS reverse proxy for hosting.
  The development Compose file remains a development setup.

### Publication steps

- [x] Authorize staging and committing the preparation changes.
- [ ] Push the approved commit and obtain passing hosted CI for it.
- [ ] Create and push `v0.1.0` on that verified commit.
- [ ] Verify both architecture images are published to GHCR, and make the package
  accessible to intended users before announcing the production install command.
- [ ] Publish a stable GitHub release (not a prerelease) using the `0.1.0`
  changelog section, including upgrade notes and the pre-1.0/AI limitations.

The following sections record the first alpha's checks and accepted audit
findings. They are historical evidence, not checks rerun for 0.1.0.

## Verification completed on 2026-10-05

- Server: 435 tests pass; type check passes.
- Client: 166 tests pass; type check, lint, and production build pass.
- Lint has four existing warnings in generated UI components and the mobile hook.
  The lint command now targets source and Vite/Vitest configuration, avoiding
  installed dependencies inside Docker.
- The build reports existing large JavaScript chunk warnings.
- A disposable source copy with fresh Docker volumes successfully installs locked
  dependencies, initializes PostgreSQL and the test database, applies migrations,
  starts the API and worker, and passes the API health check.
- Compose defaults API and worker to development and resolves production when
  selected. Container checks confirm production secure cookies and forge-host
  restrictions, development behavior, and rejection of the invalid value `prod`.
- The hosted GitHub Actions run passes on the release pull request.
- Gitleaks scans all 37 local Git commits and tracked/publishable new files without
  finding leaks. Ignored environment files are excluded from the publishable-file
  scan. A separate scan of the disposable setup flagged its intentionally generated
  local encryption key, not a committed credential. Remote-only history is outside
  this scan.

Secret scanner image used:
`zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.
These checks reduce uncertainty but are not a comprehensive security audit.

## Dependency audit findings

Audits ran inside Docker using `npm audit --json`. Counts include affected parent
packages, not just distinct advisories. `npm audit fix --force` was not used: its
suggested fixes downgrade major Prisma/shadcn versions.

| Area | Initial report | Resolution |
| ---- | -------------- | ---------- |
| Server | 4 high-severity package entries: Prisma, its config, deepmerge-ts, and mysql2 | **Remediated.** `overrides` in `server/package.json` pin `mysql2@^3.24.5` and `deepmerge-ts@^8.0.2` inside the Prisma toolchain. `npm audit` reports 0 vulnerabilities, with and without dev dependencies. Server tests, type check, and `prisma validate` pass with the overrides. Drop them once Prisma ships the patched versions itself. |
| Client | 7 high-severity package entries through shadcn registry/tooling, ts-morph, fast-glob, micromatch, and braces | **Accepted for alpha.** No patched `braces` release exists (latest 3.0.3 is affected). `shadcn` moved to `devDependencies`: the app only imports its CSS at build time, so `npm audit --omit=dev` reports 0 vulnerabilities and nothing affected ships in the browser bundle. The remaining findings are a denial-of-service risk in local build tooling when given untrusted glob patterns. Revisit when braces or shadcn publish a fix. |

The underlying advisories reported by npm are
[deepmerge-ts recursion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[mysql2 credential exposure](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr),
[mysql2 decompression](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3), and
[braces recursion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).

## Maintainer actions before publication

- [x] Confirm permission to license original code and branding assets under MIT.
- [x] Enable GitHub private vulnerability reporting and verify the private report
  link in SECURITY.md and CODE_OF_CONDUCT.md works for reporters.
- [x] Review and explicitly accept or remediate the dependency audit findings for
  the alpha release.
- [x] Obtain a passing hosted CI run after an authorized commit and push
  ([run 37313406503](https://github.com/rdlugs/sentryward/actions/runs/37313406503)).
- [ ] Announce alpha status, AI review limitations, and development-only Docker
  infrastructure. `NODE_ENV=production` changes backend behavior, not deployment
  infrastructure.

No browser walkthrough, screenshots, live model review, or production deployment
was performed. Browser actions need explicit approval. Changes remain unstaged
until staging or committing is authorized.
