// ============================================================================
// Shared lookups the harnesses need before they can drive the platform.
//
// The administrative surfaces take a session rather than raw ids, and the
// audit trigger has a foreign key to app_user, so a harness cannot invent a
// user id: an invented one fails at the audit write, several layers below the
// operation under test, and looks like a platform defect.
// ============================================================================

import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';

export interface HarnessSession {
  userId: UUID;
  tenantId: UUID;
  clientId: null;
  role: string;
  name: string;
  exp: number;
}

/** Find a real tenant administrator to act as. */
export async function resolveAdminUser(
  db: Queryable, tenantId: UUID,
): Promise<UUID> {
  const result = await db.query(
    `SELECT user_id FROM app_user
      WHERE tenant_id = $1 AND role = 'tenant_admin' AND deleted_at IS NULL
      ORDER BY created_at
      LIMIT 1`, [tenantId]);
  if (result.rows.length === 0) {
    throw new Error(
      `no tenant_admin exists for tenant ${tenantId}; the harness needs one to `
      + 'exercise the administrative surfaces, and the audit trigger will reject '
      + 'a user id that is not on file');
  }
  return result.rows[0].user_id;
}

export function harnessSession(
  userId: UUID, tenantId: UUID, name: string,
): HarnessSession {
  return {
    userId, tenantId, clientId: null, role: 'tenant_admin',
    name, exp: Date.now() + 3_600_000,
  };
}
