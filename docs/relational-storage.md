# CrewYard relational storage

SQL is applied manually. The application does not run database migrations.

## Existing CrewYard installation

1. Back up `board_private.state` and pause writes.
2. Apply `supabase-relational-schema.sql` once.
3. Apply `supabase-migrate-relational.sql` before enabling the relational application build. The migration checks source and target counts and keeps `board_private.state` untouched.
4. Confirm the migrated data and switch the application to relational storage. Keep the legacy state row until cutover is verified.

The migration can be rerun while the source is unchanged and before relational writes begin. It rejects an altered legacy source or unexpected target counts.

For the September 2026 hosted pilot, all legacy collections were empty. The guarded
`supabase-empty-pilot-cutover.sql` transaction was applied to CrewYard instead of
copying rows with the general migration. The old state row was retained, and the
cutover marker and activity counter were verified afterward. This pilot script
must not be used if any legacy collection contains records.

## Fresh CrewYard installation

Apply `supabase-relational-schema.sql` once. It creates all relational tables and seeds `board_private.activity_counter` with `next_id = 1`. Do not apply the legacy `supabase-schema.sql` or the state migration.

The schema script adds named constraints and is intentionally a one-time script.
