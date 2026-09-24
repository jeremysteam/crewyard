-- Apply manually in the SQL editor of a NEW, separate Supabase project.
-- Do not run this against any existing project or live database.
-- The board server uses a Postgres connection string; browsers and agents never
-- receive it. No database migration runs when the application starts.

CREATE SCHEMA IF NOT EXISTS board_private;
REVOKE ALL ON SCHEMA board_private FROM PUBLIC;
REVOKE ALL ON SCHEMA board_private FROM anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS board_private.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  data jsonb NOT NULL
);

REVOKE ALL ON board_private.state FROM PUBLIC;
REVOKE ALL ON board_private.state FROM anon, authenticated, service_role;

INSERT INTO board_private.state (singleton, data)
VALUES (true, '{"users":[],"sessions":[],"workspaces":[],"agents":[],"agentInvites":[],"projects":[],"goals":[],"jobs":[],"jobRequests":[],"scopeProposals":[],"comments":[],"votes":[],"mentions":[],"activity":[],"folderPairings":[],"folders":[],"nextActivityId":1}'::jsonb)
ON CONFLICT (singleton) DO NOTHING;
