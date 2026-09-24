-- LEGACY singleton schema. Existing CrewYard installations retain this table
-- during the relational cutover. New relational installations use
-- supabase-relational-schema.sql; existing installations then apply
-- supabase-migrate-relational.sql manually after taking a backup.
-- This file is retained for reference; do not reapply it during cutover.
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
