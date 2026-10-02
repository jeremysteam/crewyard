-- Apply manually before deploying the coordination feature.
-- Never run this from the application or an agent.
BEGIN;

ALTER TABLE board_private.workspaces ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE board_private.agents ADD COLUMN IF NOT EXISTS can_manage boolean NOT NULL DEFAULT false;
ALTER TABLE board_private.jobs ADD COLUMN IF NOT EXISTS assigned_agent_id text REFERENCES board_private.agents(id);

CREATE TABLE IF NOT EXISTS board_private.announcements (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
  kind text NOT NULL CHECK (kind IN ('message','pause','resume','assignment')),
  body text NOT NULL,
  target_agent_id text REFERENCES board_private.agents(id),
  job_id text REFERENCES board_private.jobs(id),
  from_type text NOT NULL, from_id text NOT NULL, from_name text NOT NULL, from_handle text NOT NULL,
  receipts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(receipts) = 'array'),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS announcements_workspace_created_idx ON board_private.announcements(workspace_id,created_at);

ALTER TABLE board_private.mentions ADD COLUMN IF NOT EXISTS announcement_id text REFERENCES board_private.announcements(id);

CREATE TABLE IF NOT EXISTS board_private.meetings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
  title text NOT NULL,
  main_agent_id text NOT NULL REFERENCES board_private.agents(id),
  participant_ids jsonb NOT NULL CHECK (jsonb_typeof(participant_ids) = 'array'),
  auto_mode boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('active','closed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_workspace_idx ON board_private.meetings(workspace_id,created_at);

CREATE TABLE IF NOT EXISTS board_private.meeting_rounds (
  id text PRIMARY KEY,
  meeting_id text NOT NULL REFERENCES board_private.meetings(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  prompt text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('open','blind','targeted')),
  target_agent_id text REFERENCES board_private.agents(id),
  participant_ids jsonb NOT NULL CHECK (jsonb_typeof(participant_ids) = 'array'),
  main_agent_id text NOT NULL REFERENCES board_private.agents(id),
  stage text NOT NULL CHECK (stage IN ('target','answers','main','synthesis','complete')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (meeting_id,ordinal)
);
CREATE INDEX IF NOT EXISTS meeting_rounds_meeting_idx ON board_private.meeting_rounds(meeting_id,ordinal);

CREATE TABLE IF NOT EXISTS board_private.meeting_responses (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES board_private.meeting_rounds(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES board_private.agents(id),
  kind text NOT NULL CHECK (kind IN ('answer','synthesis')),
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (round_id,agent_id,kind)
);
CREATE INDEX IF NOT EXISTS meeting_responses_round_idx ON board_private.meeting_responses(round_id,created_at);

CREATE TABLE IF NOT EXISTS board_private.meeting_votes (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES board_private.meeting_rounds(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES board_private.agents(id),
  mode text NOT NULL CHECK (mode IN ('open','blind')),
  created_at timestamptz NOT NULL,
  UNIQUE (round_id,agent_id)
);
CREATE INDEX IF NOT EXISTS meeting_votes_round_idx ON board_private.meeting_votes(round_id);

CREATE TABLE IF NOT EXISTS board_private.meeting_memories (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES board_private.workspaces(id),
  agent_id text NOT NULL REFERENCES board_private.agents(id),
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id,agent_id)
);

REVOKE ALL ON ALL TABLES IN SCHEMA board_private FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
