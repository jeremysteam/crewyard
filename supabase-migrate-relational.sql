-- CrewYard source-only migration. Run manually after supabase-relational-schema.sql
-- and before the relational app receives traffic. Reruns are for pre-cutover
-- verification only; live relational writes will make count checks fail.
-- Take an independent backup first. This transaction reads but never modifies
-- board_private.state; retain that row until the application cutover is verified.
BEGIN;
SELECT pg_advisory_xact_lock(735824019);

CREATE TABLE IF NOT EXISTS board_private.relational_migrations (
  name text PRIMARY KEY, source_md5 text NOT NULL, migrated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON board_private.relational_migrations FROM PUBLIC, anon, authenticated, service_role;

-- Convert camelCase to snake_case and expand immutable actor snapshots.
CREATE OR REPLACE FUNCTION board_private._legacy_row(p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE k text; v jsonb; snake text; out_row jsonb := '{}'::jsonb;
BEGIN
  FOR k, v IN SELECT key, value FROM jsonb_each(p_row) LOOP
    snake := lower(regexp_replace(k, '([A-Z])', '_\1', 'g'));
    IF k IN ('createdBy','submittedBy','decidedBy','startedBy','askedBy',
             'respondedBy','cancelledBy','assignee','author','voter','actor','from')
       AND jsonb_typeof(v) = 'object' THEN
      out_row := out_row || jsonb_build_object(
        snake || '_type', coalesce(v->>'type',v->>'kind'),
        snake || '_id', v->>'id',
        snake || '_name', v->>'name',
        snake || '_handle', v->>'handle');
    ELSE
      out_row := out_row || jsonb_build_object(snake, v);
    END IF;
  END LOOP;
  RETURN out_row;
END $$;

DO $$
DECLARE source_state jsonb; source_hash text; existing_hash text;
        target_name text; source_key text; source_count bigint; target_count bigint;
        row_value jsonb; job_value jsonb; child_value jsonb; n bigint;
BEGIN
  SELECT data INTO STRICT source_state FROM board_private.state WHERE singleton = true FOR SHARE;
  source_hash := md5(source_state::text);
  SELECT source_md5 INTO existing_hash FROM board_private.relational_migrations WHERE name = 'state_to_relational_v1';
  IF existing_hash IS NOT NULL AND existing_hash <> source_hash THEN
    RAISE EXCEPTION 'Legacy state changed since relational migration; stop and reconcile before rerun';
  END IF;

  IF existing_hash IS NULL THEN
    -- An unmarked, populated target is unsafe to merge into. A failed prior run
    -- rolls back in full, so this also detects unexpected manual edits.
    FOREACH target_name IN ARRAY ARRAY[
      'users','sessions','workspaces','projects','agent_invites','agents',
      'agent_invite_redemptions','project_work_locations','goals','jobs','job_runs',
      'job_submissions','job_review_decisions','job_requests','scope_proposals',
      'comments','votes','mentions','activity','folder_pairings','folders'
    ] LOOP
      EXECUTE format('SELECT count(*) FROM board_private.%I', target_name) INTO target_count;
      IF target_count <> 0 THEN
        RAISE EXCEPTION 'Target %.% already has % rows; refusing migration',
          'board_private', target_name, target_count;
      END IF;
    END LOOP;

    -- Parents before dependents. Each source array is an entity collection;
    -- no collection is copied into a JSONB column.
    FOR target_name, source_key IN
      SELECT * FROM (VALUES
        ('users','users'),('sessions','sessions'),('workspaces','workspaces'),
        ('projects','projects'),('agent_invites','agentInvites'),('agents','agents'),
        ('goals','goals'),('jobs','jobs'),('job_requests','jobRequests'),
        ('scope_proposals','scopeProposals'),('comments','comments'),
        ('votes','votes'),('mentions','mentions'),('activity','activity'),
        ('folder_pairings','folderPairings'),('folders','folders')
      ) AS mapping(target_name, source_key)
    LOOP
      IF jsonb_typeof(source_state->source_key) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Legacy state key % is not an array', source_key;
      END IF;
      FOR row_value IN SELECT value FROM jsonb_array_elements(source_state->source_key) LOOP
        row_value := board_private._legacy_row(row_value);
        IF target_name = 'projects' THEN
          row_value := jsonb_build_object('scope_plan','', 'review_instructions','') || row_value;
        ELSIF target_name = 'agents' THEN
          row_value := jsonb_build_object('can_review',false) || row_value;
        ELSIF target_name = 'jobs' THEN
          row_value := jsonb_build_object('starting_point','{}'::jsonb) || row_value;
        ELSIF target_name = 'scope_proposals' THEN
          row_value := jsonb_build_object('plan','') || row_value;
        ELSIF target_name = 'job_requests' THEN
          row_value := jsonb_build_object('context','','recommendation','') || row_value;
        ELSIF target_name = 'votes' THEN
          row_value := jsonb_build_object('reason','') || row_value;
        ELSIF target_name = 'activity' THEN
          row_value := jsonb_build_object('detail','') || row_value;
        END IF;
        EXECUTE format(
          'INSERT INTO board_private.%I SELECT (jsonb_populate_record(NULL::board_private.%I, $1)).*',
          target_name,target_name
        ) USING row_value;
      END LOOP;
    END LOOP;

    -- Child collections and historical records. The current records are
    -- appended only if absent from their corresponding history arrays.
    FOR row_value IN SELECT value FROM jsonb_array_elements(source_state->'projects') LOOP
      FOR child_value IN SELECT value FROM jsonb_array_elements(coalesce(row_value->'workLocations','[]'::jsonb)) LOOP
        INSERT INTO board_private.project_work_locations(id,project_id,label,kind,target,created_at)
        VALUES (child_value->>'id',row_value->>'id',child_value->>'label',
                child_value->>'kind',child_value->>'target',(child_value->>'createdAt')::timestamptz);
      END LOOP;
    END LOOP;
    FOR row_value IN SELECT value FROM jsonb_array_elements(source_state->'agentInvites') LOOP
      FOR child_value IN SELECT value FROM jsonb_array_elements(coalesce(row_value->'redemptions','[]'::jsonb)) LOOP
        INSERT INTO board_private.agent_invite_redemptions(agent_id,invite_id,name,created_at)
        VALUES (child_value->>'agentId',row_value->>'id',child_value->>'name',(child_value->>'createdAt')::timestamptz);
      END LOOP;
    END LOOP;
    FOR job_value IN SELECT value FROM jsonb_array_elements(source_state->'jobs') LOOP
      n := 0;
      FOR child_value IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_array_length(coalesce(job_value->'runs','[]'::jsonb)) > 0
          THEN job_value->'runs'
          WHEN job_value->'run' IS NOT NULL THEN jsonb_build_array(job_value->'run')
          ELSE '[]'::jsonb END
      ) LOOP
        n := n + 1;
        row_value := board_private._legacy_row(child_value)
          || jsonb_build_object('job_id',job_value->>'id','ordinal',n);
        INSERT INTO board_private.job_runs
        SELECT (jsonb_populate_record(NULL::board_private.job_runs,row_value)).*;
      END LOOP;
      n := 0;
      FOR child_value IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_array_length(coalesce(job_value->'submissionHistory','[]'::jsonb)) > 0
          THEN job_value->'submissionHistory'
          WHEN job_value->'submission' IS NOT NULL THEN jsonb_build_array(job_value->'submission')
          ELSE '[]'::jsonb END
      ) LOOP
        n := n + 1;
        row_value := board_private._legacy_row(child_value)
          || jsonb_build_object('id',coalesce(child_value->>'id',(job_value->>'id') || ':submission:' || n),
                                'job_id',job_value->>'id','ordinal',n,
                                'run_id',child_value->'run'->>'id');
        INSERT INTO board_private.job_submissions
        SELECT (jsonb_populate_record(NULL::board_private.job_submissions,row_value)).*;
      END LOOP;
      n := 0;
      FOR child_value IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_array_length(coalesce(job_value->'reviewHistory','[]'::jsonb)) > 0
          THEN job_value->'reviewHistory'
          WHEN job_value->'reviewDecision' IS NOT NULL THEN jsonb_build_array(job_value->'reviewDecision')
          ELSE '[]'::jsonb END
      ) LOOP
        n := n + 1;
        row_value := board_private._legacy_row(child_value)
          || jsonb_build_object('id',(job_value->>'id') || ':review:' || n,
                                'job_id',job_value->>'id','ordinal',n);
        INSERT INTO board_private.job_review_decisions
        SELECT (jsonb_populate_record(NULL::board_private.job_review_decisions,row_value)).*;
      END LOOP;
      UPDATE board_private.jobs SET
        current_run_id = job_value->'run'->>'id',
        current_submission_id = coalesce(job_value->'submission'->>'id',
          CASE WHEN job_value->'submission' IS NOT NULL
            THEN (job_value->>'id') || ':submission:' ||
              greatest(1,jsonb_array_length(coalesce(job_value->'submissionHistory','[]'::jsonb))) END),
        current_review_decision_id = CASE WHEN job_value->'reviewDecision' IS NOT NULL
          THEN (job_value->>'id') || ':review:' ||
            greatest(1,jsonb_array_length(coalesce(job_value->'reviewHistory','[]'::jsonb))) END
      WHERE id = job_value->>'id';
    END LOOP;
    INSERT INTO board_private.activity_counter(singleton,next_id)
      VALUES (true, greatest(coalesce((source_state->>'nextActivityId')::bigint,1),
                            coalesce((SELECT max(id)+1 FROM board_private.activity),1)))
      ON CONFLICT (singleton) DO UPDATE SET next_id = EXCLUDED.next_id;
    INSERT INTO board_private.relational_migrations(name,source_md5)
      VALUES ('state_to_relational_v1',source_hash);
  END IF;

  -- Reruns validate as well as initial execution. Any mismatch aborts the
  -- transaction and leaves the original singleton untouched.
  FOR target_name, source_key IN
    SELECT * FROM (VALUES
      ('users','users'),('sessions','sessions'),('workspaces','workspaces'),
      ('projects','projects'),('agent_invites','agentInvites'),('agents','agents'),
      ('goals','goals'),('jobs','jobs'),('job_requests','jobRequests'),
      ('scope_proposals','scopeProposals'),('comments','comments'),
      ('votes','votes'),('mentions','mentions'),('activity','activity'),
      ('folder_pairings','folderPairings'),('folders','folders')
    ) AS mapping(target_name,source_key)
  LOOP
    EXECUTE format('SELECT count(*) FROM board_private.%I',target_name) INTO target_count;
    source_count := jsonb_array_length(source_state->source_key);
    IF target_count <> source_count THEN
      RAISE EXCEPTION 'Count mismatch for %: source %, target %', target_name,source_count,target_count;
    END IF;
  END LOOP;
  SELECT count(*) INTO target_count FROM board_private.project_work_locations;
  SELECT coalesce(sum(jsonb_array_length(coalesce(value->'workLocations','[]'::jsonb))),0)
    INTO source_count FROM jsonb_array_elements(source_state->'projects');
  IF target_count <> source_count THEN RAISE EXCEPTION 'Work location count mismatch'; END IF;
  SELECT count(*) INTO target_count FROM board_private.agent_invite_redemptions;
  SELECT coalesce(sum(jsonb_array_length(coalesce(value->'redemptions','[]'::jsonb))),0)
    INTO source_count FROM jsonb_array_elements(source_state->'agentInvites');
  IF target_count <> source_count THEN RAISE EXCEPTION 'Invite redemption count mismatch'; END IF;
  SELECT count(*) INTO target_count FROM board_private.job_runs;
  SELECT coalesce(sum(CASE WHEN jsonb_array_length(coalesce(value->'runs','[]'::jsonb)) > 0
    THEN jsonb_array_length(value->'runs') WHEN value->'run' IS NOT NULL THEN 1 ELSE 0 END),0)
    INTO source_count FROM jsonb_array_elements(source_state->'jobs');
  IF target_count <> source_count THEN RAISE EXCEPTION 'Job run count mismatch'; END IF;
  SELECT count(*) INTO target_count FROM board_private.job_submissions;
  SELECT coalesce(sum(CASE WHEN jsonb_array_length(coalesce(value->'submissionHistory','[]'::jsonb)) > 0
    THEN jsonb_array_length(value->'submissionHistory')
    WHEN value->'submission' IS NOT NULL THEN 1 ELSE 0 END),0)
    INTO source_count FROM jsonb_array_elements(source_state->'jobs');
  IF target_count <> source_count THEN RAISE EXCEPTION 'Job submission count mismatch'; END IF;
  SELECT count(*) INTO target_count FROM board_private.job_review_decisions;
  SELECT coalesce(sum(CASE WHEN jsonb_array_length(coalesce(value->'reviewHistory','[]'::jsonb)) > 0
    THEN jsonb_array_length(value->'reviewHistory')
    WHEN value->'reviewDecision' IS NOT NULL THEN 1 ELSE 0 END),0)
    INTO source_count FROM jsonb_array_elements(source_state->'jobs');
  IF target_count <> source_count THEN RAISE EXCEPTION 'Job review decision count mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM board_private.jobs j
    WHERE (j.current_run_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM board_private.job_runs r WHERE r.id = j.current_run_id AND r.job_id = j.id))
       OR (j.current_submission_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM board_private.job_submissions s WHERE s.id = j.current_submission_id AND s.job_id = j.id))
       OR (j.current_review_decision_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM board_private.job_review_decisions d WHERE d.id = j.current_review_decision_id AND d.job_id = j.id))
  ) THEN RAISE EXCEPTION 'Job current history pointer mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM board_private.activity_counter WHERE singleton = true) THEN
    RAISE EXCEPTION 'Activity counter missing';
  END IF;
END $$;

DROP FUNCTION board_private._legacy_row(jsonb);
COMMIT;
