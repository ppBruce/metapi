# Metapi Engineering Rules

These rules apply to the whole repository unless a deeper `AGENTS.md` overrides
them. They are intentionally opinionated and mechanical so humans and agents can
make small, consistent changes without re-learning the codebase each time.

## Golden Principles

- Prefer one source of truth. If a helper, contract, or workflow already owns
  an invariant, extend it instead of creating a parallel implementation.
- Fix the family, not just the symptom. When a bug comes from a repeated
  pattern, sweep adjacent paths in the same subsystem before calling the work
  done.
- Keep changes narrow and reviewable. Land one coherent slice at a time and
  avoid bundling unrelated cleanup into the same patch.

## Upstream Sync And Verification

- Treat upstream syncs as incremental maintenance. Compare against the last
  adopted upstream revision, identify the local customization commits, and
  preserve their intent and these local rules during conflict resolution.
  Keep customizations separate and traceable; avoid unrelated refactoring.
- Choose the smallest useful verification set from the actual diff and
  manually resolved conflicts. Prefer existing tests for the changed behavior.
  Do not run every adjacent suite or add tests just because a merge occurred.
  Reuse successful upstream CI evidence for unchanged upstream code when
  available; do not assume it passed without checking.
- For routine Docker updates, default to focused review, affected tests where
  needed, one production image build, and a brief deployed version/health check
  plus one relevant management endpoint. Use that same image for deployment.
  Do not duplicate compiler checks already covered by the build or run desktop
  checks for a Docker-only change. Once applicable checks pass, proceed to the
  authorized deployment and finish; rerun only checks invalidated by new edits
  or failures.
- Broaden validation only for a concrete unresolved risk, such as an uncertain
  migration, a dependency/runtime incompatibility, or a manual change to
  credentials, billing, or routing semantics. State the reason and target that
  risk. Full-suite runs, database-copy rehearsals, exhaustive row comparisons,
  every-key API probes, and live inference calls are not routine requirements.
  Existing architecture and schema guardrails still apply when relevant.
- Keep rollback preparation lightweight: record the previous Git revision,
  retain its image, and back up configuration and a consistent database before
  a production switch. Do not routinely export full Git bundles or Docker
  image archives, or make repeated equivalent backups. Add those only when
  the normal rollback materials would be insufficient.
- Reuse deployment details and suitable commands/scripts from `docs/plans/`,
  after confirming the current container, source, and data paths. Avoid
  repeating historical investigations or building a new deployment framework
  for each update. Keep progress notes and handoff evidence concise.
- Documentation and agent-instruction-only edits require a diff/content
  review and `git diff --check`; do not run application tests, builds, or
  database rehearsals unless executable code or contracts also changed.

## Server Layers

- `src/server/routes/**` are adapters, not owners. Route files may register
  Fastify endpoints, parse request context, and delegate. They must not own
  protocol conversion, retry policy, stream lifecycle, billing, or
  persistence.
- If a helper is imported by anything outside one route file, it does not
  belong under `src/server/routes/proxy/`.
- `src/server/proxy-core/**` owns proxy orchestration. Endpoint fallback should
  flow through `executeEndpointFlow()`. Channel/session bookkeeping should flow
  through `sharedSurface.ts`.
- `src/server/transformers/**` are protocol-pure. Do not import from
  `src/server/routes/**`, Fastify, OAuth services, token router, or runtime
  dispatch modules. If a transformer needs a shared contract, move it to a
  neutral module first.
- Whole-body upstream reads in proxy orchestration should use
  `readRuntimeResponseText()` instead of direct `.text()` reads.

## Platform And Routing Rules

- Platform behavior must be explicit. Detection, endpoint preference, discovery
  transport, and management capability should come from one declared capability
  story, not scattered `if platform === ...` branches.
- Thin adapters must stay honest. Do not let a platform look feature-complete
  through inherited defaults if the underlying upstream does not support the
  feature.
- Retry classification and routing health classification should share the same
  failure vocabulary whenever possible.

## Database Rules

- One schema change requires three synchronized outputs: update the Drizzle
  schema, update SQLite migration history, and regenerate checked-in schema
  artifacts together.
- Cross-dialect bootstrap and upgrade SQL must be generated from the schema
  contract. Do not hand-write new MySQL/Postgres schema patches in feature
  code.
- Legacy schema compatibility is temporary and spec-owned. Additive startup
  shims should stay narrow and trace back to a feature compatibility spec.

## Web Rules

- Pages are orchestration surfaces, not shared utility libraries. Do not import
  one top-level page from another top-level page.
- Mobile behavior should reuse existing shared primitives first:
  `ResponsiveFilterPanel`, `ResponsiveBatchActionBar`, `MobileCard`,
  `useIsMobile`, and `mobileLayout.ts`.
- When a page grows a second complex modal, drawer, or panel family, extract it
  into a domain subfolder before adding more inline state and rendering logic.

## Guardrails

- Run `npm run repo:drift-check` before finishing changes that touch shared
  architecture boundaries.
- If you add a new boundary-heavy module, add or extend an architecture test in
  the same area so the rule becomes executable.
- Keep local planning files under `docs/plans/`. They are intentionally ignored
  by git and should not be treated as published documentation.
