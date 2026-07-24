-- ============================================================================
-- 0016_tenant_rls_fix.sql
--
-- Bug fix: 0008's generic RLS loop swept up `tenant` itself (it has a
-- column literally named tenant_id — its own primary key — so it matched
-- the loop's "every table with a tenant_id column" condition), applying
-- the standard tenant_id = app.current_tenant_id() policy to it. That's
-- wrong for the root table of the hierarchy: it makes it structurally
-- impossible to ever INSERT a new tenant, since app.current_tenant_id()
-- can never equal a tenant that doesn't exist yet.
--
-- This should have been excluded from the generic loop and special-cased
-- like `payer` and `audit_log` already were. It went undetected until now
-- because every environment tested so far connects as a Postgres superuser
-- (which bypasses RLS/FORCE RLS entirely) — the first real, non-superuser
-- role (a Cloud SQL database user) surfaced it immediately: creating a
-- tenant failed with "new row violates row-level security policy".
--
-- Fix: INSERT is unconditional (access control for "who can create a
-- tenant" is enforced by createTenant() being CLI-only, never an HTTP
-- route — see src/web/admin_api.ts); SELECT/UPDATE/DELETE stay scoped to
-- a session's own tenant, matching the original intent.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON tenant;

CREATE POLICY tenant_insert ON tenant FOR INSERT
  WITH CHECK (true);
CREATE POLICY tenant_read ON tenant FOR SELECT
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_update ON tenant FOR UPDATE
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY tenant_delete ON tenant FOR DELETE
  USING (tenant_id = app.current_tenant_id());

COMMIT;
