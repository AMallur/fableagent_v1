-- ============================================================================
-- 0017_pretenant_lookup_functions.sql
--
-- Bug fix: login, API-key authentication, and accept-invite all need to
-- resolve WHICH tenant a credential belongs to before any tenant context
-- exists to scope a normal query by — but standard RLS (tenant_id =
-- app.current_tenant_id()) makes every row on app_user/api_key invisible
-- until that context is set. Chicken and egg: with real RLS enforcement
-- (not the accidental superuser bypass every environment has had so far),
-- nobody could ever log in.
--
-- Cloud SQL doesn't grant BYPASSRLS to any customer-connectable role
-- (verified directly against a live instance) — so this doesn't rely on
-- that attribute at all. It uses ordinary Postgres RLS-owner-exemption
-- semantics instead: a dedicated, login-less role owns exactly the two
-- tables these lookups touch, RLS is enabled but NOT forced on them (so
-- that owner is exempt), and a small SECURITY DEFINER function per lookup
-- resolves ONLY the tenant_id — nothing else. The app then sets
-- app.current_tenant_id to that value and re-runs the real, detailed
-- lookup as a normal, fully RLS-scoped query through its usual role.
--
-- Deliberately not SET ROLE to a bypassrls-capable role instead (rcm_service
-- from 0008 happens to already have that attribute): SET ROLE's elevated
-- state persists on the connection until explicitly reset, and pg.Pool
-- reuses connections across unrelated requests — an error path that skips
-- the reset would leave a later, unrelated request silently running with
-- RLS bypassed. A SECURITY DEFINER function's elevated execution is scoped
-- to exactly that one function call, with no such leakage risk.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rcm_pretenant_lookup') THEN
    CREATE ROLE rcm_pretenant_lookup NOLOGIN;
  END IF;
END $$;
-- PostgreSQL 16 grants the creator ADMIN membership automatically. CI and
-- managed databases may also pre-provision the membership, and re-granting it
-- from the member back to itself fails with "ADMIN option cannot be granted
-- back to your own grantor". Grant only when membership is actually absent.
DO $$
BEGIN
  IF NOT pg_has_role(CURRENT_USER, 'rcm_pretenant_lookup', 'MEMBER') THEN
    EXECUTE format(
      'GRANT rcm_pretenant_lookup TO %I WITH ADMIN OPTION', CURRENT_USER
    );
  END IF;
END $$;
-- ALTER OWNER requires the new owner to have CREATE on the object's schema.
-- Tables live in public; functions live in app. Keep public CREATE only for
-- the table ownership transfer below, then revoke it immediately.
GRANT USAGE, CREATE ON SCHEMA public, app TO rcm_pretenant_lookup;

ALTER TABLE app_user NO FORCE ROW LEVEL SECURITY;
ALTER TABLE api_key NO FORCE ROW LEVEL SECURITY;
-- Preserve the connecting role's day-to-day privileges before transferring
-- ownership (never DELETE; matches the rest of the schema).
GRANT SELECT, INSERT, UPDATE, REFERENCES ON app_user, api_key TO CURRENT_USER;
ALTER TABLE app_user OWNER TO rcm_pretenant_lookup;
ALTER TABLE api_key OWNER TO rcm_pretenant_lookup;
REVOKE CREATE ON SCHEMA public FROM rcm_pretenant_lookup;

CREATE OR REPLACE FUNCTION app.resolve_tenant_by_email(p_email citext) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT tenant_id FROM app_user
  WHERE email = p_email AND status = 'active' AND deleted_at IS NULL
  ORDER BY created_at LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_tenant_by_email(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_email(citext) TO CURRENT_USER;
ALTER FUNCTION app.resolve_tenant_by_email(citext) OWNER TO rcm_pretenant_lookup;

CREATE OR REPLACE FUNCTION app.resolve_tenant_by_invite_token(p_token text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT tenant_id FROM app_user
  WHERE invite_token = p_token AND invite_expires_at > now()
    AND status = 'pending' AND deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.resolve_tenant_by_invite_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_invite_token(text) TO CURRENT_USER;
ALTER FUNCTION app.resolve_tenant_by_invite_token(text) OWNER TO rcm_pretenant_lookup;

CREATE OR REPLACE FUNCTION app.resolve_tenant_by_api_key_hash(p_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT tenant_id FROM api_key WHERE key_hash = p_hash AND revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.resolve_tenant_by_api_key_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_api_key_hash(text) TO CURRENT_USER;
ALTER FUNCTION app.resolve_tenant_by_api_key_hash(text) OWNER TO rcm_pretenant_lookup;

COMMIT;
