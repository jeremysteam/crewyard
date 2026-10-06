# Egress reduction

This document describes the initial containment release (`25d8e9`). The subsequent scoped-write, shared-wait, pagination and quota implementation is documented in [SaaS scaling](saas-scaling.md), with a separate manual SQL and staged rollout gate.

The callback-based relational loader read almost every table on many small requests. These transfers count as Supabase egress even when the API response contains no changes.

## Application patch

- Common GET routes declare their required tables in server/read-scope.mjs. Authentication is rechecked inside each read transaction; session expiration, revocation, project boundaries and blind-response filtering remain enforced.
- Scoped PostgreSQL reads filter workspaces by owner or assigned workspace, projects by that scope and agent root, and related rows by foreign keys. Job comments and nested job histories are restricted on detail reads. Public user reads exclude password hashes.
- Meeting waits query authorization and the meeting version while unchanged, loading the transcript only after a change or timeout. Version checks preserve current manager permissions.
- Browser polling runs serially, stops in hidden tabs, and catches up when visible. Crew City makes no activity requests in hidden tabs. The local animation clock does not use the database.

## Verification and remaining work

Offline tests use file fixtures and a SQL recorder, never a real database. Database integration tests are disabled for this task. There is no schema change or SQL to apply.

This is an initial containment patch. Writes still use the existing full callback snapshot and global writer lock. Unknown read routes retain the compatible loader. Meeting detail still includes retained cross-meeting memory context, and waiting responses still include the meeting at timeout. These should be replaced with targeted writes, bounded histories, and a shared event channel before a large public launch.

No production egress reduction percentage is claimed. Confirm savings from hourly Supabase uncached-egress deltas and the service breakdown after deployment; historic usage is not erased.
