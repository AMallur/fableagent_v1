-- ============================================================================
-- 0018_payer_shared_insert.sql
--
-- Bug fix: payer_insert (0008) requires tenant_id = app.current_tenant_id(),
-- with no carve-out for genuinely shared/global master-data rows
-- (tenant_id IS NULL, per payer_read's own USING clause and the payer
-- table's whole design intent — "global master rows visible to everyone").
-- NULL = current_tenant_id() is never true in SQL regardless of what
-- current_tenant_id() actually is, so there was no valid way to insert a
-- shared payer at all, through any path.
--
-- Fix: allow a NULL tenant_id insert specifically when current_tenant_id()
-- is ALSO unset — i.e. only a connection with no tenant context at all
-- (platform-level seeding/tooling) can create shared master data. Every
-- authenticated, tenant-scoped session always has current_tenant_id() set,
-- and createTenantPayer() (src/web/admin_api.ts) always inserts with
-- tenant_id = the caller's own tenant regardless of input — so this can
-- never be reached through the normal app layer, only by a script that
-- deliberately never sets a tenant context.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS payer_insert ON payer;
CREATE POLICY payer_insert ON payer FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    OR (tenant_id IS NULL AND app.current_tenant_id() IS NULL)
  );

COMMIT;
