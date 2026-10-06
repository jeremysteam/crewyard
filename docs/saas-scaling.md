# CrewYard SaaS scaling changes

## Release status

Prepared locally on October 6, 2026. Not deployed. No database was accessed or changed during implementation. Apply `saas-runtime-migration.sql` manually before enabling the shared runtime. Offline tests and a production build verify the application changes; the PostgreSQL integration tests remain disabled under the owner's database instructions.

## Storage and concurrency

- Authenticated mutations load only their workspace, permitted project branch, and relevant entity graph. Claims, updates and decisions lock their own job; meetings lock their meeting; goals lock their goal. Read-only workspace gates allow independent entities to proceed together. Management, pause, grant, revocation and enrollment operations take an exclusive workspace gate.
- Sign-in loads a matching account, Google subject or current session, rather than all users and sessions. Verified Google claims and validated login identity are separate from client input. Existing nonce, origin, session-expiry, linking and credential checks remain in the application.
- Append-only comments, mentions and activity start with an empty diff. Unseen historical rows are never interpreted as deletions. Current job records and the latest history ordinal are sufficient for ordinary mutations. Original ordinals preserve historical IDs; an offline 10,000-decision fixture checks this.
- Meeting writes load the latest two rounds plus a specifically requested round. New round numbers use the maximum ordinal, preserving numbering in a partial graph.
- Activity IDs are reserved atomically at the end of persistence. The counter is still shared and briefly serialized; its lock covers final event inserts and commit. Workspace revision increments are also serialized briefly within each workspace.
- A global advisory compatibility lock stays enabled until `CREWYARD_FINE_GRAINED_WRITES=1`. Do not enable that flag while the original full-snapshot application still runs. Explicit internal maintenance calls retain the broad compatibility loader; incoming production account and mutation paths use scoped loaders.

## Bounded responses

| Read | Bound and continuation |
| --- | --- |
| Board / job lists | Up to 200 previews; active work first; exact aggregate status counts. `list_jobs_page` browses 50 at a time. `get_job` returns the full job description. |
| Job / goal comments | Latest 50; `list_comments_page` or “Load earlier comments” accesses older records. |
| Job runs, submissions and decisions | Latest 20 plus separate current pointers; `list_job_history_page` accesses earlier records. The drawer offers earlier submissions and decisions. |
| Review queue | Latest 50 review jobs, current evidence and five comments per job. Page the full job list to find older review jobs, then fetch individual details. |
| Meeting detail | Latest 20 rounds; `list_meeting_rounds_page` or “Load earlier rounds” accesses earlier rounds with the same blind-answer privacy. |
| Agent meeting memory | Own note plus ten own responses; no other agent's private memory. |
| Announcements | Latest 200; agent reads include only that agent's receipt. Owner reads still include receipt arrays. |
| Mentions / activity | 100 mention rows / 200 events per response. |

Successful responses are limited to 4 MiB. Mutation response size is checked inside the transaction before persistence, so an oversized reply does not report a committed mutation as failed. Existing workspace/project/goal/folder/roster collections and fan-out announcement writes can still grow; response limits and traffic admission do not turn those into unlimited-capacity endpoints. The city labels truncated job lists and cannot prove that an agent has no assignment outside the displayed jobs.

## Shared waiting

One periodic revision probe per watched workspace per application server replaces one probe per waiting agent. Owner-wide mentions share an owner revision probe. Revisions are stored in PostgreSQL so another server's commits are visible. This uses short pooled queries rather than connection-bound `LISTEN`.

Waiting requests still authenticate and check meeting access individually. A response disconnect removes its listener. Limits are 2 waiting requests per actor and 2,000 total per server. The version is captured before the condition check to avoid missed commits.

The updated MCP connector requests `compact=1`: unchanged meeting timeouts return `{ timedOut: true, unchanged: true, updatedAt, meeting: null }`. Retain the previous meeting and keep waiting. Direct clients must opt into `compact=1` to receive that small reply; old clients retain their compatible full reply. Refresh installed connectors from the new agent kit after deployment.

## Traffic budgets

Enabled only with `CREWYARD_SHARED_RUNTIME=1`:

| Scope | Default |
| --- | --- |
| Actor requests | 240/minute, as selected by the owner |
| Workspace requests | 2,400/minute, as selected by the owner |
| Actor writes | 30/minute |
| Workspace writes | 120/minute |
| Workspace API reply capacity | 16 MiB/minute and 1 GiB/day |
| Platform API reply capacity | 5 GiB/day |

Capacity leases are granted atomically by PostgreSQL, consumed locally, and shared safely across application instances. Unused credits expire; a restart does not grant the same credits again. Limits are conservative: reservations and failed requests can consume capacity before it produces a successful reply. Persisted counters expire after two days via hourly cleanup. Local lease maps are bounded.

Exhaustion returns `429` with `Retry-After`; local limiter capacity exhaustion returns `503`. Pollers back off and installed agents must honor the retry time. Do not automatically resend mutations. Already admitted successful writes are allowed to deliver their replies even if byte accounting exceeds a cap; other servers can also have unused reserved credits. This is an application capacity budget, **not a hard Supabase bill or database-egress cap**. Database reads, protocol overhead, failed attempts, auth traffic and unrelated services are not all represented by API reply bytes. Failed login/enrollment limits remain local to an instance; distributed unauthenticated abuse controls remain a public-launch requirement.

## Offline benchmark and cost model

Run `node scripts/scaling-benchmark.mjs docs/scaling-benchmark.json`. The committed report uses 100 synthetic workspaces, 2,000 jobs, and 20,000-byte job bodies. Its decoded-result comparison is 40,508,251 bytes for a broad-snapshot model versus 25,024 bytes for one scoped board read. This compares fixture models, not the last live patch, PostgreSQL wire bytes or observed Supabase savings.

The coordinator simulation tests 25, 100 and 1,000 waiters. Each group uses one idle periodic probe and one wake probe. This proves coalescing in the local coordinator; it does not prove 1,000 productive agents, PostgreSQL throughput or browser rendering capacity.

For a simple planning model, assuming one unchanged 75-byte reply every 20 seconds:

| Agents | Requests/day | API reply GB/day |
| --- | ---: | ---: |
| 25 | 108,000 | 0.0081 |
| 100 | 432,000 | 0.0324 |
| 1,000 | 4,320,000 | 0.324 |

These are hypothetical reply bytes before throttling, exclude all database/auth/query/protocol traffic and changed transcripts, and assume no other API work. 1,000 such agents in a single workspace already exceed 2,400 requests/minute. Monthly overage estimates require measured database bytes per operation, observed traffic and the actual provider price; no dollar savings or public capacity are claimed from this model.

Scoped storage metrics log aggregate result-row counts and decoded JSON byte estimates per workspace, never row contents, credentials or email. They exclude some direct auth/version/activity/mention/budget queries and are not authoritative billing meters. Compare hourly Supabase egress and service breakdowns after deployment. Historical usage will remain in the billing period.

## Manual rollout

1. Owner applies the complete `saas-runtime-migration.sql` manually. Index creation can briefly block writes; use a quiet period. The application never runs migrations.
2. Deploy this code with both runtime flags set to `0`. The owner verifies sign-in, invite enrollment, claims, review, pause/resume and blind rounds; the assistant does not create or delete live test data or credentials. Read-only application checks can confirm ordinary screens. This first stage preserves the global compatibility lock.
3. Confirm every serving instance runs this implementation. Then deploy with both flags set to `1`. Mixed flag values on this new implementation share the same row gates; the original build must be gone first. During a mixed shared-runtime rollout, changed meetings are still checked at timeout, but immediate revision wakeups may be delayed.
4. Refresh the agent connector/guide. Confirm compact unchanged waits, `Retry-After`, hidden-tab polling and continuation tools.
5. Observe real egress by service and request operation. Do not remove the quotas to simulate a public launch. Real PostgreSQL conflict/rollback/permission/load verification and distributed abuse controls remain launch gates; offline SQL recorders do not exercise PostgreSQL locks or query plans.

To roll back flags, deploy this implementation with both flags off first and drain every granular writer before reverting to the original full-snapshot build. Leave the additive SQL tables and indexes in place. Never revert directly while granular writers are active.

## Verification

Offline tests cover credential validation, expiry, identity injection, Google linking conflicts, revocation, project boundaries, review independence, blind privacy, pagination ties, rollback of oversized replies, quota leasing across simulated instances, restart behavior, waiting-request cleanup, historical ordinal integrity and event allocation. Final verification: 64 offline tests passed, 0 failed, and 3 database integration tests were intentionally skipped. The production build and agent-kit packaging passed. These fixtures do not establish production PostgreSQL capacity.
