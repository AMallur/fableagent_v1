// ============================================================================
// Disaster recovery verification.
//
// docs/OPERATIONAL_RESILIENCE_RUNBOOK.md defines a restore exercise and
// docs/PRODUCTION_READINESS.md lists it as an external gate. A documented
// exercise that has never been run tells a customer nothing, and "we take
// backups" is not the claim that matters — the claim that matters is that what
// comes back is the same money.
//
// The fingerprint below is what makes that checkable. It is taken before the
// backup and recomputed after the restore, and it covers the figures a
// customer would dispute: what was billed, what the ledger says, and the
// content hash of the evidence pack the customer can recompute themselves.
// ============================================================================

import { createHash } from 'node:crypto';
import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';
import { checkInvariants, formatInvariantReport, type InvariantReport } from './invariants.ts';

export interface RecoveryFingerprint {
  tenantId: UUID;
  /** Row counts per table that carries financial or evidentiary weight. */
  counts: Record<string, number>;
  /** Money totals, as text so numeric precision survives the round trip. */
  totals: Record<string, string>;
  /** Digest over every invoice and its lines, in a fixed order. */
  invoiceDigest: string;
  /** Digest over the append-only ledger, in a fixed order. */
  ledgerDigest: string;
  /** Digest over the audit trail. */
  auditDigest: string;
}

const FINGERPRINT_TABLES = [
  'claim', 'claim_line', 'remittance', 'remittance_line', 'recovery_case',
  'appeal_packet', 'payment_event', 'usage_event', 'invoice', 'invoice_line',
  'audit_log', 'go_live_check',
];

// Separators that cannot occur inside a rendered column value, so two
// different row shapes cannot collide by concatenation.
const UNIT_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

async function digest(db: Queryable, sql: string, params: unknown[]): Promise<string> {
  const result = await db.query(sql, params);
  const hash = createHash('sha256');
  for (const row of result.rows) {
    // Column order is fixed by the query and every value is rendered the same
    // way on both sides of the restore, so the digest compares content rather
    // than driver representation.
    hash.update(Object.values(row)
      .map((value) => (value === null ? '' : String(value)))
      .join(UNIT_SEPARATOR));
    hash.update(RECORD_SEPARATOR);
  }
  return hash.digest('hex');
}

export async function fingerprint(db: Queryable, tenantId: UUID): Promise<RecoveryFingerprint> {
  const counts: Record<string, number> = {};
  for (const table of FINGERPRINT_TABLES) {
    const result = await db.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    counts[table] = result.rows[0].n;
  }

  const totals = await db.query(
    `SELECT
       COALESCE(sum(i.amount_due), 0)::text          AS invoice_amount_due,
       COALESCE(sum(i.attributed_recovery), 0)::text AS invoice_attributed_recovery,
       COALESCE(sum(i.contingency_fee), 0)::text     AS invoice_contingency_fee
     FROM invoice i WHERE i.tenant_id = $1 AND i.status <> 'void'`, [tenantId]);
  const ledgerTotals = await db.query(
    `SELECT COALESCE(sum(amount), 0)::text AS ledger_amount,
            (count(*) FILTER (WHERE invoice_id IS NOT NULL))::text AS ledger_billed_rows
     FROM usage_event WHERE tenant_id = $1`, [tenantId]);

  return {
    tenantId,
    counts,
    totals: { ...totals.rows[0], ...ledgerTotals.rows[0] },
    invoiceDigest: await digest(db,
      `SELECT i.invoice_number, i.status, i.period_start, i.amount_due,
              i.attributed_recovery, i.contingency_fee, i.issued_at,
              il.claim_number, il.payer_name, il.payment_date,
              il.amount_recovered, il.fee
         FROM invoice i
         LEFT JOIN invoice_line il ON il.invoice_id = i.invoice_id
        WHERE i.tenant_id = $1
        ORDER BY i.invoice_number NULLS LAST, i.period_start,
                 il.claim_number NULLS LAST, il.amount_recovered NULLS LAST,
                 il.fee NULLS LAST`, [tenantId]),
    ledgerDigest: await digest(db,
      `SELECT usage_event_id, event_type, occurred_at, amount, payment_event_id,
              attribution_basis, invoice_id
         FROM usage_event WHERE tenant_id = $1 ORDER BY usage_event_id`, [tenantId]),
    auditDigest: await digest(db,
      `SELECT log_id, action, entity_type, entity_id, created_at
         FROM audit_log WHERE tenant_id = $1 ORDER BY log_id`, [tenantId]),
  };
}

export interface FingerprintDifference {
  field: string;
  before: string;
  after: string;
}

export function compareFingerprints(
  before: RecoveryFingerprint, after: RecoveryFingerprint,
): FingerprintDifference[] {
  const differences: FingerprintDifference[] = [];
  const note = (field: string, a: unknown, b: unknown) => {
    if (String(a) !== String(b)) {
      differences.push({ field, before: String(a), after: String(b) });
    }
  };

  for (const table of FINGERPRINT_TABLES) {
    note(`count.${table}`, before.counts[table], after.counts[table]);
  }
  for (const key of Object.keys(before.totals)) {
    note(`total.${key}`, before.totals[key], after.totals[key]);
  }
  note('digest.invoice', before.invoiceDigest, after.invoiceDigest);
  note('digest.ledger', before.ledgerDigest, after.ledgerDigest);
  note('digest.audit', before.auditDigest, after.auditDigest);
  return differences;
}

export interface RecoveryReport {
  tenantId: UUID;
  before: RecoveryFingerprint;
  after: RecoveryFingerprint;
  differences: FingerprintDifference[];
  /** Wall time from the start of the restore to a verified database. */
  restoreMs: number;
  backupMs: number;
  backupBytes: number;
  invariants: InvariantReport;
  /** Evidence-pack hash before and after, which a customer can recompute. */
  evidenceHashBefore: string | null;
  evidenceHashAfter: string | null;
  recovered: boolean;
}

/**
 * `after` is taken by the caller rather than computed here, because ordering
 * matters: exporting an evidence pack is itself an audited action, so building
 * the post-restore pack before fingerprinting would add an audit row that the
 * pre-backup fingerprint could not contain, and the exercise would report a
 * failure it had caused itself.
 */
export async function verifyRestore(
  db: Queryable, tenantId: UUID,
  before: RecoveryFingerprint, after: RecoveryFingerprint,
  timings: { backupMs: number; restoreMs: number; backupBytes: number },
  evidenceHashBefore: string | null,
  evidenceHashAfter: string | null,
): Promise<RecoveryReport> {
  const differences = compareFingerprints(before, after);
  const invariants = await checkInvariants(db, tenantId);
  return {
    tenantId, before, after, differences,
    backupMs: timings.backupMs,
    restoreMs: timings.restoreMs,
    backupBytes: timings.backupBytes,
    invariants,
    evidenceHashBefore, evidenceHashAfter,
    recovered: differences.length === 0
      && invariants.clean
      && evidenceHashBefore === evidenceHashAfter,
  };
}

export function formatRecoveryReport(report: RecoveryReport): string {
  const lines: string[] = ['# Disaster recovery exercise', ''];
  lines.push(`Backup: ${(report.backupBytes / 1_000_000).toFixed(1)} MB in `
    + `${(report.backupMs / 1000).toFixed(1)}s`);
  lines.push(`Restore to a verified database: **${(report.restoreMs / 1000).toFixed(1)}s** `
    + '— a measured recovery time on this hardware, not a target');
  lines.push('');
  lines.push('## Did the money come back');
  lines.push('');
  if (report.differences.length === 0) {
    lines.push('Every counted row, every money total and all three digests match '
      + 'the state captured before the backup.');
  } else {
    lines.push('| field | before | after |');
    lines.push('|---|---|---|');
    for (const difference of report.differences) {
      lines.push(`| ${difference.field} | ${difference.before} | ${difference.after} |`);
    }
  }
  lines.push('');
  lines.push('## Evidence pack');
  lines.push('');
  if (report.evidenceHashBefore === null) {
    lines.push('No evidence pack was built, so the customer-verifiable hash was not compared.');
  } else {
    lines.push(`before \`${report.evidenceHashBefore}\``);
    lines.push('');
    lines.push(`after  \`${report.evidenceHashAfter}\``);
    lines.push('');
    lines.push(report.evidenceHashBefore === report.evidenceHashAfter
      ? 'The hash a customer would recompute is unchanged by the restore.'
      : '**The evidence-pack hash changed across the restore.**');
  }
  lines.push('');
  lines.push('## Invariants after restore');
  lines.push('');
  lines.push(formatInvariantReport(report.invariants));
  lines.push('');
  lines.push(report.recovered
    ? 'Restore verified.'
    : '**Restore did NOT reproduce the pre-failure state.**');
  return lines.join('\n');
}
