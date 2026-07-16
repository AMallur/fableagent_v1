-- ============================================================================
-- 0015_sftp_inbound.sql
-- Credentials for the embedded per-client SFTP server (engine/src/integration
-- /sftp_server.ts). Deliberately separate from client_integration's existing
-- sftp_host/sftp_port/sftp_username/sftp_password_encrypted columns — those
-- were shaped for connecting OUT to a client-owned SFTP host (never actually
-- wired to any outbound connection logic) and stay as-is for that possible
-- future use. This is the other direction: WE run the server, and issue the
-- client a username/password to push files TO us.
--
-- Password is scrypt-hashed (via web/auth.ts hashPassword/verifyPassword),
-- same as app_user — never stored reversibly, matching how we already treat
-- every other credential a human authenticates with.
-- ============================================================================

BEGIN;

ALTER TABLE client_integration
  ADD COLUMN sftp_inbound_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN sftp_inbound_username      text,
  ADD COLUMN sftp_inbound_password_hash text,
  ADD COLUMN sftp_inbound_created_at    timestamptz;

-- global uniqueness: the SFTP server authenticates a connection by username
-- alone (it doesn't know the tenant/client until it looks the username up),
-- so this lookup must be unambiguous across the whole platform.
CREATE UNIQUE INDEX uq_client_integration_sftp_username
  ON client_integration (sftp_inbound_username)
  WHERE sftp_inbound_username IS NOT NULL;

COMMIT;
