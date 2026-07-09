// ============================================================================
// Authentication: scrypt password hashing + stateless HMAC-signed session
// cookies. No session table — the cookie carries a signed, expiring payload.
// ============================================================================

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export const COOKIE_NAME = 'rcm_session';
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 's2' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface Session {
  userId: UUID;
  tenantId: UUID;
  clientId: UUID | null;   // null = tenant-wide user
  role: string;
  name: string;
  exp: number;
  /** tenant session timeout in minutes (for sliding renewal) */
  tm?: number;
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeSession(s: Session, secret: string): string {
  const payload = b64u(JSON.stringify(s));
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSession(token: string | undefined, secret: string): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s: Session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// login — with lockout, MFA enforcement for admin roles, and password
// rotation enforcement. Returns a discriminated outcome the route maps to
// HTTP statuses. All security events land in the audit trail.
// ---------------------------------------------------------------------------

import {
  ADMIN_ROLES, generateTotpSecret, otpauthUri, passwordExpiredForRole,
  encryptSecret, decryptSecret, verifyTotp,
} from '../security/crypto.ts';

export type AuthOutcome =
  | { kind: 'ok'; session: Session }
  | { kind: 'invalid' }
  | { kind: 'locked'; until: string }
  | { kind: 'mfa_enroll'; secret: string; otpauthUri: string }
  | { kind: 'mfa_required' }
  | { kind: 'mfa_invalid' }
  | { kind: 'password_expired' };

async function securityEvent(
  db: Queryable, tenantId: UUID, userId: UUID | null, action: string, detail: object, ip: string | null,
): Promise<void> {
  await db.query(
    `SELECT app.log_security_event($1, $2, $3, $4, $5::inet)`,
    [tenantId, userId, action, JSON.stringify(detail), ip],
  ).catch(async () => {
    // fall back to direct insert (works for service/owner roles)
    await db.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, after_state, ip_address)
       VALUES ($1, $2, $3, 'app_user', $2, $4, $5::inet)`,
      [tenantId, userId, action, JSON.stringify(detail), ip]).catch(() => {});
  });
}

export async function authenticate(
  db: Queryable, email: string, password: string,
  opts: { totp?: string; ip?: string | null } = {},
): Promise<AuthOutcome> {
  const rows = await db.query(
    `SELECT u.user_id, u.tenant_id, u.client_id, u.role, u.first_name, u.last_name,
            u.password_hash, u.failed_login_attempts, u.locked_until,
            u.password_changed_at, u.mfa_enabled, u.mfa_secret,
            t.session_timeout_minutes, t.enforce_mfa
     FROM app_user u JOIN tenant t ON t.tenant_id = u.tenant_id
     WHERE u.email = $1 AND u.status = 'active' AND u.deleted_at IS NULL
     ORDER BY u.created_at LIMIT 1`,
    [email],
  );
  const u = rows.rows[0];
  if (!u) return { kind: 'invalid' };
  const ip = opts.ip ?? null;

  // lockout check
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
    return { kind: 'locked', until: new Date(u.locked_until).toISOString() };
  }

  if (!verifyPassword(password, u.password_hash)) {
    const attempts = u.failed_login_attempts + 1;
    const lock = attempts >= LOCKOUT_ATTEMPTS;
    await db.query(
      `UPDATE app_user SET failed_login_attempts = $1,
              locked_until = CASE WHEN $2 THEN now() + interval '${LOCKOUT_MINUTES} minutes' END
       WHERE user_id = $3`,
      [lock ? 0 : attempts, lock, u.user_id]);
    await securityEvent(db, u.tenant_id, u.user_id,
      lock ? 'login_lockout' : 'login_failed', { email, attempts }, ip);
    if (lock) {
      return { kind: 'locked', until: new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() };
    }
    return { kind: 'invalid' };
  }

  // MFA for admin roles when the tenant enforces it
  if (u.enforce_mfa && ADMIN_ROLES.has(u.role)) {
    if (!u.mfa_enabled || !u.mfa_secret) {
      // start enrollment: persist an (encrypted) pending secret
      let secret: string;
      if (u.mfa_secret) {
        secret = decryptSecret(u.mfa_secret);
      } else {
        secret = generateTotpSecret();
        // pending secret; mfa_enabled stays false until a code verifies
        await db.query(
          `UPDATE app_user SET mfa_secret = $1, mfa_enabled = false WHERE user_id = $2`,
          [encryptSecret(secret), u.user_id]);
      }
      if (opts.totp && verifyTotp(secret, opts.totp)) {
        await db.query(
          `UPDATE app_user SET mfa_enabled = true WHERE user_id = $1`, [u.user_id]);
        await securityEvent(db, u.tenant_id, u.user_id, 'mfa_enrolled', { email }, ip);
        // fall through to normal login
      } else {
        return { kind: 'mfa_enroll', secret, otpauthUri: otpauthUri(secret, email) };
      }
    } else {
      if (!opts.totp) return { kind: 'mfa_required' };
      if (!verifyTotp(decryptSecret(u.mfa_secret), opts.totp)) {
        await securityEvent(db, u.tenant_id, u.user_id, 'mfa_failed', { email }, ip);
        return { kind: 'mfa_invalid' };
      }
    }
  }

  // 90-day rotation for admin roles
  if (passwordExpiredForRole(u.role, u.password_changed_at)) {
    return { kind: 'password_expired' };
  }

  await db.query(
    `UPDATE app_user SET last_login = now(), failed_login_attempts = 0, locked_until = NULL
     WHERE user_id = $1`, [u.user_id]);
  await securityEvent(db, u.tenant_id, u.user_id, 'login_succeeded', { email }, ip);

  const timeoutMinutes = u.session_timeout_minutes ?? 30;
  return {
    kind: 'ok',
    session: {
      userId: u.user_id,
      tenantId: u.tenant_id,
      clientId: u.client_id,
      role: u.role,
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || email,
      exp: Date.now() + timeoutMinutes * 60_000,
      tm: timeoutMinutes,
    },
  };
}

/** issue a session directly (SSO assertion path) */
export async function sessionForUser(
  db: Queryable, userId: UUID,
): Promise<Session | null> {
  const rows = await db.query(
    `SELECT u.user_id, u.tenant_id, u.client_id, u.role, u.first_name, u.last_name, u.email,
            t.session_timeout_minutes
     FROM app_user u JOIN tenant t ON t.tenant_id = u.tenant_id
     WHERE u.user_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL`, [userId]);
  const u = rows.rows[0];
  if (!u) return null;
  await db.query(`UPDATE app_user SET last_login = now() WHERE user_id = $1`, [userId]);
  const tm = u.session_timeout_minutes ?? 30;
  return {
    userId: u.user_id, tenantId: u.tenant_id, clientId: u.client_id, role: u.role,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    exp: Date.now() + tm * 60_000, tm,
  };
}

/** change password with old-password proof and policy enforcement (no session needed) */
export async function changePassword(
  db: Queryable, email: string, oldPassword: string, newPassword: string,
  validate: (pw: string) => { ok: boolean; errors: string[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await db.query(
    `SELECT user_id, tenant_id, password_hash FROM app_user
     WHERE email = $1 AND status = 'active' AND deleted_at IS NULL
     ORDER BY created_at LIMIT 1`, [email]);
  const u = rows.rows[0];
  if (!u || !verifyPassword(oldPassword, u.password_hash)) {
    return { ok: false, error: 'invalid credentials' };
  }
  const policy = validate(newPassword);
  if (!policy.ok) return { ok: false, error: `password policy: ${policy.errors.join('; ')}` };
  await db.query(
    `UPDATE app_user SET password_hash = $1, password_changed_at = now(),
            failed_login_attempts = 0, locked_until = NULL
     WHERE user_id = $2`,
    [hashPassword(newPassword), u.user_id]);
  await securityEvent(db, u.tenant_id, u.user_id, 'password_changed', { email }, null);
  return { ok: true };
}

/** clients this session may see (client-scoped user -> theirs; else all of tenant) */
export async function visibleClientIds(db: Queryable, s: Session): Promise<UUID[]> {
  if (s.clientId) return [s.clientId];
  const rows = await db.query(
    `SELECT client_id FROM client WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [s.tenantId],
  );
  return rows.rows.map((r) => r.client_id);
}
