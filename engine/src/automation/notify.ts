// ============================================================================
// NOTIFICATION SYSTEM
//
// createNotification resolves the recipient's preference for the type:
//   * in-app row (always stored; pre-marked read when in-app is disabled)
//   * email disposition: 'immediate' -> email_outbox row now,
//     'digest' -> collected by sendDigests, 'off' -> no email.
//   Urgent severity upgrades 'digest' to 'immediate' (spec: urgent alerts as
//   immediate email) unless the user set email 'off'.
//
// Email delivery uses the outbox pattern: rows are queued in email_outbox and
// a transport adapter drains them (deliverOutbox). The default transport logs
// the send — swap in SMTP/SES in production without touching callers.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

export type NotificationType =
  | 'case_assigned' | 'deadline_approaching' | 'payment_received'
  | 'new_cases' | 'job_summary' | 'system_alert' | 'rule_notification';

export interface NotifyInput {
  tenantId: UUID;
  userId: UUID;
  type: NotificationType;
  severity?: 'info' | 'warning' | 'urgent';
  title: string;
  body?: string;
  caseId?: UUID | null;
  /** same key = at most one notification (e.g. one deadline alert per case/tier/day) */
  dedupeKey?: string;
}

export async function createNotification(
  db: Queryable, input: NotifyInput,
): Promise<{ notificationId: UUID | null; emailed: boolean }> {
  const severity = input.severity ?? 'info';

  const pref = await db.query(
    `SELECT in_app, email FROM notification_preference
     WHERE user_id = $1 AND notification_type = $2`,
    [input.userId, input.type],
  );
  const inApp: boolean = pref.rows[0]?.in_app ?? true;
  let emailMode: string = pref.rows[0]?.email ?? 'digest';
  if (severity === 'urgent' && emailMode === 'digest') emailMode = 'immediate';

  const inserted = await db.query(
    `INSERT INTO notification
       (tenant_id, user_id, notification_type, severity, title, body, case_id,
        email_disposition, dedupe_key, read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING notification_id`,
    [input.tenantId, input.userId, input.type, severity, input.title,
     input.body ?? null, input.caseId ?? null, emailMode,
     input.dedupeKey ?? null, inApp],
  );
  if (!inserted.rows[0]) return { notificationId: null, emailed: false }; // deduped

  let emailed = false;
  if (emailMode === 'immediate') {
    const user = await db.query(
      `SELECT email FROM app_user WHERE user_id = $1`, [input.userId]);
    if (user.rows[0]) {
      await db.query(
        `INSERT INTO email_outbox (tenant_id, user_id, to_email, subject, body_text, kind)
         VALUES ($1, $2, $3, $4, $5, 'immediate')`,
        [input.tenantId, input.userId, user.rows[0].email,
         `[RCM${severity === 'urgent' ? ' URGENT' : ''}] ${input.title}`,
         input.body ?? input.title],
      );
      emailed = true;
    }
  }
  return { notificationId: inserted.rows[0].notification_id, emailed };
}

/** notify every active user with one of the given roles in a tenant */
export async function notifyRoles(
  db: Queryable, tenantId: UUID, roles: string[],
  input: Omit<NotifyInput, 'tenantId' | 'userId'>,
): Promise<number> {
  const users = await db.query(
    `SELECT user_id FROM app_user
     WHERE tenant_id = $1 AND role = ANY($2) AND status = 'active' AND deleted_at IS NULL`,
    [tenantId, roles],
  );
  let n = 0;
  for (const u of users.rows) {
    const r = await createNotification(db, {
      ...input, tenantId, userId: u.user_id,
      dedupeKey: input.dedupeKey ? `${input.dedupeKey}:u:${u.user_id}` : undefined,
    });
    if (r.notificationId) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// digest emails — one email per user bundling undigested notifications.
// Daily users get one whenever the digest job runs (once per local day);
// weekly users only on Mondays.
// ---------------------------------------------------------------------------

export async function sendDigests(
  db: Queryable, tenantId: UUID, opts: { isMonday: boolean },
): Promise<number> {
  const pending = await db.query(
    `SELECT n.notification_id, n.user_id, n.title, n.body, n.severity, n.created_at,
            u.email, u.digest_frequency
     FROM notification n JOIN app_user u ON u.user_id = n.user_id
     WHERE n.tenant_id = $1 AND n.email_disposition = 'digest' AND n.digested_at IS NULL
       AND u.digest_frequency <> 'off'
       AND (u.digest_frequency = 'daily' OR $2)
     ORDER BY n.user_id, n.created_at`,
    [tenantId, opts.isMonday],
  );
  if (pending.rows.length === 0) return 0;

  const byUser = new Map<string, typeof pending.rows>();
  for (const r of pending.rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id)!.push(r);
  }

  let sent = 0;
  for (const [userId, rows] of byUser) {
    const lines = rows.map((r) =>
      `• ${r.severity === 'urgent' ? '[URGENT] ' : ''}${r.title}`
      + (r.body ? `\n    ${r.body}` : ''));
    await db.query(
      `INSERT INTO email_outbox (tenant_id, user_id, to_email, subject, body_text, kind)
       VALUES ($1, $2, $3, $4, $5, 'digest')`,
      [tenantId, userId, rows[0].email,
       `[RCM] Your notification digest (${rows.length} update${rows.length > 1 ? 's' : ''})`,
       `Notification digest\n\n${lines.join('\n')}\n`],
    );
    await db.query(
      `UPDATE notification SET digested_at = now() WHERE notification_id = ANY($1)`,
      [rows.map((r) => r.notification_id)],
    );
    sent += 1;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// outbox delivery
// ---------------------------------------------------------------------------

export interface EmailTransport {
  send(email: {
    emailId: UUID; toEmail: string; subject: string; bodyText: string; kind: string;
  }): Promise<void>;
}

/** default transport: logs the delivery (queued rows stay auditable) */
export class LogTransport implements EmailTransport {
  async send(email: { toEmail: string; subject: string }): Promise<void> {
    console.log(`[email] to=${email.toEmail} subject="${email.subject}"`);
  }
}

/** test transport: collects sends in memory */
export class MemoryTransport implements EmailTransport {
  readonly sent: Array<{ toEmail: string; subject: string; bodyText: string; kind: string }> = [];
  async send(email: any): Promise<void> { this.sent.push(email); }
}

export async function deliverOutbox(
  db: Queryable, transport: EmailTransport, limit = 100,
): Promise<{ sent: number; failed: number }> {
  const rows = await db.query(
    `SELECT email_id, to_email, subject, body_text, kind FROM email_outbox
     WHERE status = 'queued' ORDER BY created_at LIMIT $1`, [limit]);
  let sent = 0, failed = 0;
  for (const r of rows.rows) {
    try {
      await transport.send({
        emailId: r.email_id, toEmail: r.to_email, subject: r.subject,
        bodyText: r.body_text, kind: r.kind,
      });
      await db.query(
        `UPDATE email_outbox SET status = 'sent', sent_at = now() WHERE email_id = $1`,
        [r.email_id]);
      sent += 1;
    } catch (err) {
      await db.query(
        `UPDATE email_outbox SET status = 'failed', error = $2 WHERE email_id = $1`,
        [r.email_id, String(err instanceof Error ? err.message : err)]);
      failed += 1;
    }
  }
  return { sent, failed };
}
