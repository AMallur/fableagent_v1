-- ============================================================================
-- 0008_rls_triggers_grants.sql
-- Cross-cutting enforcement, applied after all tables exist:
--   1. updated_at maintenance triggers on every table that has the column
--   2. Row-level security: tenant isolation on every tenant-scoped table
--   3. Database roles and grants (rcm_app = RLS-bound application role,
--      rcm_service = RLS-bypassing ingestion/maintenance role)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. updated_at triggers — generated for every public table with the column
-- ----------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
      t.table_name, t.table_name);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Row-level security
--
-- Standard policy: a session sees only rows whose tenant_id matches
-- app.current_tenant_id(). FORCE means even the table owner is bound —
-- only roles with BYPASSRLS (rcm_service) skip the check.
--
-- Special cases handled explicitly below the loop:
--   payer     — shared master rows (tenant_id IS NULL) are readable by all
--               tenants; tenants may only write their own rows
--   audit_log — tenant-scoped reads; inserts come from the SECURITY DEFINER
--               trigger; no UPDATE/DELETE policy => append-only under RLS
-- ----------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'tenant_id'
      AND table_name NOT IN ('payer', 'audit_log')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         FOR ALL
         USING (tenant_id = app.current_tenant_id())
         WITH CHECK (tenant_id = app.current_tenant_id())',
      t.table_name);
  END LOOP;
END $$;

-- payer: global master rows visible to everyone, writes only to own rows
ALTER TABLE payer ENABLE ROW LEVEL SECURITY;
ALTER TABLE payer FORCE ROW LEVEL SECURITY;
CREATE POLICY payer_read ON payer FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app.current_tenant_id());
CREATE POLICY payer_insert ON payer FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY payer_update ON payer FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- audit_log: tenant-scoped SELECT, open INSERT (write access is controlled by
-- grants — only the SECURITY DEFINER trigger and rcm_service can insert),
-- and no UPDATE/DELETE policies => immutable under RLS
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 3. Roles and grants
--   rcm_app     — the application's connection role. RLS-bound. No DELETE
--                 anywhere (soft delete is the only delete) except the
--                 appeal_packet_document join table. Cannot forge audit rows.
--   rcm_service — ingestion / detection / maintenance jobs. BYPASSRLS.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_app') THEN
    CREATE ROLE rcm_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_service') THEN
    CREATE ROLE rcm_service NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO rcm_app, rcm_service;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO rcm_app, rcm_service;

-- application role: read/write but never hard-delete
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO rcm_app;
GRANT DELETE ON appeal_packet_document TO rcm_app;
-- audit log is read-only for the app; rows arrive via the definer trigger
REVOKE INSERT, UPDATE ON audit_log FROM rcm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rcm_app;

-- service role: full access, bypasses RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rcm_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rcm_service;

COMMIT;
