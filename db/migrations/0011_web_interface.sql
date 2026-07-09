-- ============================================================================
-- 0011_web_interface.sql
-- Support for the operational web interface (engine/src/web):
--   * app_user.password_hash — scrypt hashes for interactive login
--   * activity-feed index on case_action
-- ============================================================================

BEGIN;

ALTER TABLE app_user
  ADD COLUMN password_hash text;

-- dashboard activity feed: latest actions across a tenant
CREATE INDEX idx_action_tenant_date ON case_action (tenant_id, action_date DESC);

COMMIT;
