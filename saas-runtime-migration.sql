-- Apply manually in Supabase before enabling CREWYARD_SHARED_RUNTIME=1.
BEGIN;
CREATE TABLE IF NOT EXISTS board_private.workspace_signals (
  workspace_id text PRIMARY KEY REFERENCES board_private.workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS board_private.request_budgets (
  scope_key text NOT NULL,
  bucket_start timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  writes integer NOT NULL DEFAULT 0 CHECK (writes >= 0),
  response_bytes bigint NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  PRIMARY KEY (scope_key, bucket_start)
);
CREATE INDEX IF NOT EXISTS request_budgets_expiry_idx ON board_private.request_budgets(bucket_start);
ALTER TABLE board_private.workspace_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_private.request_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON board_private.workspace_signals, board_private.request_budgets FROM anon, authenticated;
INSERT INTO board_private.workspace_signals (workspace_id)
SELECT id FROM board_private.workspaces ON CONFLICT (workspace_id) DO NOTHING;
-- Cursor and own-memory lookups. Run during a quiet period: ordinary index
-- creation can briefly block table writes while the index is built.
CREATE INDEX IF NOT EXISTS jobs_project_updated_cursor_idx ON board_private.jobs(project_id,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS comments_job_cursor_idx ON board_private.comments(job_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS comments_goal_cursor_idx ON board_private.comments(goal_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS meeting_responses_agent_cursor_idx ON board_private.meeting_responses(agent_id,created_at DESC,id DESC);
COMMIT;
