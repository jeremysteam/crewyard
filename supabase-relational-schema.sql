-- CrewYard only. One-time schema script: ALTER ADD CONSTRAINT is intentionally
-- not rerunnable. Apply manually after backing up board_private.state.
-- Run supabase-migrate-relational.sql before sending app traffic to these tables.
-- The app never creates or changes schema. Keep the old state row through cutover.
BEGIN;
CREATE SCHEMA IF NOT EXISTS board_private;
REVOKE ALL ON SCHEMA board_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS board_private.users (
 id text PRIMARY KEY, name text NOT NULL, handle text NOT NULL UNIQUE, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS board_private.sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES board_private.users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON board_private.sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON board_private.sessions(expires_at);
CREATE TABLE IF NOT EXISTS board_private.workspaces (
 id text PRIMARY KEY, name text NOT NULL, owner_id text NOT NULL REFERENCES board_private.users(id),
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON board_private.workspaces(owner_id);
CREATE TABLE IF NOT EXISTS board_private.projects (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
 parent_project_id text REFERENCES board_private.projects(id), name text NOT NULL,
 description text NOT NULL DEFAULT '', brief jsonb NOT NULL DEFAULT '{}'::jsonb,
 scope_plan text NOT NULL DEFAULT '', review_instructions text NOT NULL DEFAULT '',
 created_by_type text, created_by_id text, created_by_name text, created_by_handle text,
 created_at timestamptz NOT NULL,
 CHECK (parent_project_id IS DISTINCT FROM id), CHECK (jsonb_typeof(brief) = 'object')
);
CREATE INDEX IF NOT EXISTS projects_workspace_parent_idx ON board_private.projects(workspace_id,parent_project_id);
CREATE TABLE IF NOT EXISTS board_private.agent_invites (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
 root_project_id text NOT NULL REFERENCES board_private.projects(id), secret_hash text NOT NULL UNIQUE,
 created_by_type text NOT NULL, created_by_id text NOT NULL, created_by_name text NOT NULL, created_by_handle text NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 max_uses integer NOT NULL CHECK (max_uses > 0),
 use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
 revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_invites_root_idx ON board_private.agent_invites(root_project_id,created_at);
CREATE TABLE IF NOT EXISTS board_private.agents (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
 root_project_id text REFERENCES board_private.projects(id),
 invite_id text REFERENCES board_private.agent_invites(id),
 name text NOT NULL, token_hash text NOT NULL UNIQUE, can_review boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS agents_workspace_idx ON board_private.agents(workspace_id);
CREATE INDEX IF NOT EXISTS agents_root_idx ON board_private.agents(root_project_id);
CREATE UNIQUE INDEX IF NOT EXISTS agents_active_name_idx ON board_private.agents(workspace_id,lower(name)) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS board_private.agent_invite_redemptions (
 agent_id text PRIMARY KEY REFERENCES board_private.agents(id) ON DELETE CASCADE,
 invite_id text NOT NULL REFERENCES board_private.agent_invites(id) ON DELETE CASCADE,
 name text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_redemptions_invite_idx ON board_private.agent_invite_redemptions(invite_id,created_at);
CREATE TABLE IF NOT EXISTS board_private.project_work_locations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id) ON DELETE CASCADE,
 label text NOT NULL, kind text NOT NULL CHECK (kind IN ('folder','link')),
 target text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS work_locations_project_idx ON board_private.project_work_locations(project_id,created_at);
CREATE TABLE IF NOT EXISTS board_private.goals (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id),
 title text NOT NULL, description text NOT NULL DEFAULT '',
 created_by_type text, created_by_id text, created_by_name text, created_by_handle text,
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_project_idx ON board_private.goals(project_id,created_at);
CREATE TABLE IF NOT EXISTS board_private.jobs (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id),
 goal_id text REFERENCES board_private.goals(id), title text NOT NULL, body text NOT NULL DEFAULT '',
 starting_point jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL CHECK (status IN ('idea','working','review','completed')),
 assignee_type text, assignee_id text, assignee_name text, assignee_handle text,
 created_by_type text NOT NULL, created_by_id text NOT NULL, created_by_name text NOT NULL, created_by_handle text NOT NULL,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 current_run_id text, current_submission_id text, current_review_decision_id text,
 CHECK (jsonb_typeof(starting_point) = 'object'),
 CHECK ((assignee_type IS NULL) = (assignee_id IS NULL))
);
CREATE INDEX IF NOT EXISTS jobs_project_status_idx ON board_private.jobs(project_id,status,created_at);
CREATE INDEX IF NOT EXISTS jobs_goal_idx ON board_private.jobs(goal_id);
CREATE INDEX IF NOT EXISTS jobs_assignee_idx ON board_private.jobs(assignee_type,assignee_id) WHERE assignee_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS board_private.job_runs (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES board_private.jobs(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK (ordinal > 0), directions jsonb NOT NULL, starting_point jsonb,
 started_by_type text NOT NULL, started_by_id text NOT NULL, started_by_name text NOT NULL, started_by_handle text NOT NULL,
 started_at timestamptz NOT NULL, UNIQUE (job_id,ordinal),
 CHECK (jsonb_typeof(directions) = 'object'),
 CHECK (starting_point IS NULL OR jsonb_typeof(starting_point) = 'object')
);
CREATE TABLE IF NOT EXISTS board_private.job_submissions (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES board_private.jobs(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK (ordinal > 0), summary text NOT NULL,
 submitted_by_type text NOT NULL, submitted_by_id text NOT NULL,
 submitted_by_name text NOT NULL, submitted_by_handle text NOT NULL,
 submitted_at timestamptz NOT NULL, run_id text REFERENCES board_private.job_runs(id),
 review_evidence jsonb, UNIQUE (job_id,ordinal),
 CHECK (review_evidence IS NULL OR jsonb_typeof(review_evidence) = 'object')
);
CREATE TABLE IF NOT EXISTS board_private.job_review_decisions (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES board_private.jobs(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK (ordinal > 0), submission_id text REFERENCES board_private.job_submissions(id),
 outcome text NOT NULL CHECK (outcome IN ('approved','changes_requested')),
 note text NOT NULL, decided_by_type text NOT NULL, decided_by_id text NOT NULL,
 decided_by_name text NOT NULL, decided_by_handle text NOT NULL,
 decided_at timestamptz NOT NULL, UNIQUE (job_id,ordinal)
);
CREATE TABLE IF NOT EXISTS board_private.job_requests (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES board_private.jobs(id) ON DELETE CASCADE,
 project_id text NOT NULL REFERENCES board_private.projects(id),
 kind text NOT NULL CHECK (kind IN ('question','blocker')),
 question text NOT NULL, context text NOT NULL DEFAULT '', recommendation text NOT NULL DEFAULT '',
 status text NOT NULL CHECK (status IN ('pending','answered','cancelled')),
 asked_by_type text NOT NULL, asked_by_id text NOT NULL, asked_by_name text NOT NULL, asked_by_handle text NOT NULL,
 created_at timestamptz NOT NULL, response text,
 responded_by_type text, responded_by_id text, responded_by_name text, responded_by_handle text,
 responded_at timestamptz,
 cancelled_by_type text, cancelled_by_id text, cancelled_by_name text, cancelled_by_handle text,
 cancelled_at timestamptz, cancellation_reason text
);
CREATE INDEX IF NOT EXISTS job_requests_job_status_idx ON board_private.job_requests(job_id,status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS job_requests_one_pending_idx ON board_private.job_requests(job_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS board_private.scope_proposals (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id) ON DELETE CASCADE,
 brief jsonb NOT NULL, plan text NOT NULL, baseline text,
 status text NOT NULL CHECK (status IN ('pending','approved','rejected')),
 submitted_by_type text NOT NULL, submitted_by_id text NOT NULL,
 submitted_by_name text NOT NULL, submitted_by_handle text NOT NULL,
 created_at timestamptz NOT NULL,
 decided_by_type text, decided_by_id text, decided_by_name text, decided_by_handle text,
 decided_at timestamptz, decision_note text, applied_brief jsonb, applied_plan text,
 CHECK (jsonb_typeof(brief) = 'object'),
 CHECK (applied_brief IS NULL OR jsonb_typeof(applied_brief) = 'object')
);
CREATE INDEX IF NOT EXISTS scope_proposals_project_status_idx ON board_private.scope_proposals(project_id,status,created_at);
CREATE TABLE IF NOT EXISTS board_private.comments (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id),
 goal_id text REFERENCES board_private.goals(id), job_id text REFERENCES board_private.jobs(id),
 author_type text NOT NULL, author_id text NOT NULL, author_name text NOT NULL, author_handle text NOT NULL,
 body text NOT NULL, created_at timestamptz NOT NULL,
 CHECK (goal_id IS NOT NULL OR job_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS comments_job_idx ON board_private.comments(job_id,created_at);
CREATE INDEX IF NOT EXISTS comments_goal_idx ON board_private.comments(goal_id,created_at);
CREATE TABLE IF NOT EXISTS board_private.votes (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES board_private.jobs(id) ON DELETE CASCADE,
 voter_type text NOT NULL, voter_id text NOT NULL, voter_name text NOT NULL, voter_handle text NOT NULL,
 value smallint NOT NULL CHECK (value IN (-1,1)), reason text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL, UNIQUE (job_id,voter_type,voter_id)
);
CREATE TABLE IF NOT EXISTS board_private.mentions (
 id text PRIMARY KEY, recipient_type text NOT NULL, recipient_id text NOT NULL,
 comment_id text REFERENCES board_private.comments(id),
 project_id text NOT NULL REFERENCES board_private.projects(id),
 goal_id text REFERENCES board_private.goals(id), job_id text REFERENCES board_private.jobs(id),
 from_type text NOT NULL, from_id text NOT NULL, from_name text NOT NULL, from_handle text NOT NULL,
 read_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mentions_recipient_unread_idx ON board_private.mentions(recipient_type,recipient_id,created_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS mentions_recipient_all_idx ON board_private.mentions(recipient_type,recipient_id,created_at DESC);
CREATE TABLE IF NOT EXISTS board_private.activity (
 id bigint PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id),
 goal_id text REFERENCES board_private.goals(id), job_id text REFERENCES board_private.jobs(id),
 actor_type text NOT NULL, actor_id text NOT NULL, actor_name text NOT NULL, actor_handle text NOT NULL,
 action text NOT NULL, detail text NOT NULL DEFAULT '', created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_project_idx ON board_private.activity(project_id,id);
CREATE TABLE IF NOT EXISTS board_private.activity_counter (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 next_id bigint NOT NULL CHECK (next_id > 0)
);
INSERT INTO board_private.activity_counter(singleton,next_id) VALUES (true,1)
ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS board_private.folder_pairings (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id) ON DELETE CASCADE,
 code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE INDEX IF NOT EXISTS folder_pairings_project_idx ON board_private.folder_pairings(project_id,expires_at);
CREATE TABLE IF NOT EXISTS board_private.folders (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES board_private.projects(id) ON DELETE CASCADE,
 path text NOT NULL, machine text NOT NULL, linked_at timestamptz NOT NULL,
 UNIQUE (project_id,path,machine)
);
CREATE INDEX IF NOT EXISTS folders_project_idx ON board_private.folders(project_id);

-- Composite relationships keep related rows within the same workspace/project.
ALTER TABLE board_private.projects ADD CONSTRAINT projects_id_workspace_unique UNIQUE (id,workspace_id);
ALTER TABLE board_private.projects ADD CONSTRAINT projects_parent_workspace_fk
  FOREIGN KEY (parent_project_id,workspace_id) REFERENCES board_private.projects(id,workspace_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE board_private.agent_invites ADD CONSTRAINT invites_root_workspace_fk
  FOREIGN KEY (root_project_id,workspace_id) REFERENCES board_private.projects(id,workspace_id);
ALTER TABLE board_private.agents ADD CONSTRAINT agents_root_workspace_fk
  FOREIGN KEY (root_project_id,workspace_id) REFERENCES board_private.projects(id,workspace_id);
ALTER TABLE board_private.goals ADD CONSTRAINT goals_id_project_unique UNIQUE (id,project_id);
ALTER TABLE board_private.jobs ADD CONSTRAINT jobs_id_project_unique UNIQUE (id,project_id);
ALTER TABLE board_private.jobs ADD CONSTRAINT jobs_goal_project_fk
  FOREIGN KEY (goal_id,project_id) REFERENCES board_private.goals(id,project_id);
ALTER TABLE board_private.job_runs ADD CONSTRAINT runs_id_job_unique UNIQUE (id,job_id);
ALTER TABLE board_private.job_submissions ADD CONSTRAINT submissions_id_job_unique UNIQUE (id,job_id);
ALTER TABLE board_private.job_review_decisions ADD CONSTRAINT decisions_id_job_unique UNIQUE (id,job_id);
ALTER TABLE board_private.job_submissions ADD CONSTRAINT submissions_run_job_fk
  FOREIGN KEY (run_id,job_id) REFERENCES board_private.job_runs(id,job_id);
ALTER TABLE board_private.job_review_decisions ADD CONSTRAINT decisions_submission_job_fk
  FOREIGN KEY (submission_id,job_id) REFERENCES board_private.job_submissions(id,job_id);
ALTER TABLE board_private.jobs ADD CONSTRAINT jobs_current_run_fk
  FOREIGN KEY (current_run_id,id) REFERENCES board_private.job_runs(id,job_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE board_private.jobs ADD CONSTRAINT jobs_current_submission_fk
  FOREIGN KEY (current_submission_id,id) REFERENCES board_private.job_submissions(id,job_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE board_private.jobs ADD CONSTRAINT jobs_current_decision_fk
  FOREIGN KEY (current_review_decision_id,id) REFERENCES board_private.job_review_decisions(id,job_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE board_private.job_requests ADD CONSTRAINT requests_job_project_fk
  FOREIGN KEY (job_id,project_id) REFERENCES board_private.jobs(id,project_id);
ALTER TABLE board_private.comments ADD CONSTRAINT comments_goal_project_fk
  FOREIGN KEY (goal_id,project_id) REFERENCES board_private.goals(id,project_id);
ALTER TABLE board_private.comments ADD CONSTRAINT comments_job_project_fk
  FOREIGN KEY (job_id,project_id) REFERENCES board_private.jobs(id,project_id);
ALTER TABLE board_private.mentions ADD CONSTRAINT mentions_goal_project_fk
  FOREIGN KEY (goal_id,project_id) REFERENCES board_private.goals(id,project_id);
ALTER TABLE board_private.mentions ADD CONSTRAINT mentions_job_project_fk
  FOREIGN KEY (job_id,project_id) REFERENCES board_private.jobs(id,project_id);
ALTER TABLE board_private.activity ADD CONSTRAINT activity_goal_project_fk
  FOREIGN KEY (goal_id,project_id) REFERENCES board_private.goals(id,project_id);
ALTER TABLE board_private.activity ADD CONSTRAINT activity_job_project_fk
  FOREIGN KEY (job_id,project_id) REFERENCES board_private.jobs(id,project_id);

REVOKE ALL ON ALL TABLES IN SCHEMA board_private FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
