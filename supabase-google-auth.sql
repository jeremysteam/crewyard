-- CrewYard only. Apply manually to the existing CrewYard Supabase project.
-- This adds Google sign-in identities without altering existing users or passwords.
BEGIN;
CREATE TABLE IF NOT EXISTS board_private.auth_identities (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES board_private.users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider = 'google'),
 subject text NOT NULL,
 email_at_link text NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE (provider, subject), UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON board_private.auth_identities(user_id);
REVOKE ALL ON board_private.auth_identities FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE board_private.auth_identities ENABLE ROW LEVEL SECURITY;
COMMIT;
