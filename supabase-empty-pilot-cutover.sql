-- CrewYard hosted pilot cutover, September 2026.
-- The legacy singleton was verified to have zero records in every collection.
-- This guarded transaction was used instead of the general migration script.
-- It aborts if the legacy state or any target table gained records.
BEGIN;
SELECT pg_advisory_xact_lock(735824019);
CREATE TABLE IF NOT EXISTS board_private.relational_migrations (
  name text PRIMARY KEY, source_md5 text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON board_private.relational_migrations FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE board_private.relational_migrations ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE src jsonb; source_key text; target_name text; target_count bigint;
BEGIN
  SELECT data INTO STRICT src FROM board_private.state WHERE singleton = true FOR SHARE;
  IF EXISTS (SELECT 1 FROM board_private.relational_migrations WHERE name = 'state_to_relational_v1') THEN
    RAISE EXCEPTION 'CrewYard migration marker already exists';
  END IF;
  FOREACH source_key IN ARRAY ARRAY[
    'users','sessions','workspaces','projects','agentInvites','agents',
    'goals','jobs','jobRequests','scopeProposals','comments','votes',
    'mentions','activity','folderPairings','folders'
  ] LOOP
    IF jsonb_typeof(src->source_key) IS DISTINCT FROM 'array'
       OR jsonb_array_length(src->source_key) <> 0 THEN
      RAISE EXCEPTION 'Legacy collection % is not empty', source_key;
    END IF;
  END LOOP;
  FOREACH target_name IN ARRAY ARRAY[
    'users','sessions','workspaces','projects','agent_invites','agents',
    'agent_invite_redemptions','project_work_locations','goals','jobs',
    'job_runs','job_submissions','job_review_decisions','job_requests',
    'scope_proposals','comments','votes','mentions','activity',
    'folder_pairings','folders'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM board_private.%I',target_name) INTO target_count;
    IF target_count <> 0 THEN
      RAISE EXCEPTION 'Target % already has % rows', target_name, target_count;
    END IF;
  END LOOP;
  IF (SELECT next_id FROM board_private.activity_counter WHERE singleton=true)
     IS DISTINCT FROM coalesce((src->>'nextActivityId')::bigint,1) THEN
    RAISE EXCEPTION 'Activity counter differs from legacy state';
  END IF;
  INSERT INTO board_private.relational_migrations(name,source_md5)
    VALUES ('state_to_relational_v1',md5(src::text));
END $$;
COMMIT;
