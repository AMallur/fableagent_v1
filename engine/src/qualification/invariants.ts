// ============================================================================
// Financial and structural invariants that must hold no matter what the
// platform was doing when it was interrupted.
//
// These are deliberately written as SQL over the finished state rather than as
// assertions inside the code being tested. A bug in the code under test cannot
// make one of these pass; only the data being right can. They are the same
// checks used by the load run, the concurrency run, the fault-injection run
// and the disaster-recovery verification, so a violation means the same thing
// in all four.
// ============================================================================

import type { Queryable } from '../db/snapshot.ts';
import type { UUID } from '../types.ts';

export interface InvariantViolation {
  invariant: string;
  /** What went wrong, in terms a person can act on. */
  detail: string;
  /** Identifying rows, capped so a systemic failure cannot flood a report. */
  examples: unknown[];
  severity: 'critical' | 'error';
}

export interface InvariantCheck {
  name: string;
  severity: 'critical' | 'error';
  /** Why a violation matters — carried into the report so it explains itself. */
  because: string;
  sql: string;
}

/**
 * Every check returns the offending rows and nothing when healthy, so the
 * result of running one is "how many ways is this wrong".
 *
 * $1 is always the tenant id.
 */
export const INVARIANTS: InvariantCheck[] = [
  {
    name: 'ledger_row_billed_at_most_once',
    severity: 'critical',
    because: 'a recovery charged on two invoices bills the customer twice for '
      + 'the same dollar, which is the one outcome a bill-once ledger may never produce',
    sql: `
      SELECT ue.usage_event_id, count(il.invoice_line_id) AS invoice_lines
      FROM usage_event ue
      JOIN invoice_line il ON il.usage_event_id = ue.usage_event_id
      WHERE ue.tenant_id = $1
      GROUP BY ue.usage_event_id
      HAVING count(il.invoice_line_id) > 1`,
  },
  {
    name: 'ledger_row_claimed_by_the_invoice_that_bills_it',
    severity: 'critical',
    because: 'a ledger row whose invoice_id disagrees with the invoice line '
      + 'holding it means the claim and the charge came apart, and the next '
      + 'period will bill it again',
    sql: `
      SELECT ue.usage_event_id, ue.invoice_id AS claimed_by, il.invoice_id AS billed_on
      FROM usage_event ue
      JOIN invoice_line il ON il.usage_event_id = ue.usage_event_id
      WHERE ue.tenant_id = $1
        AND ue.invoice_id IS DISTINCT FROM il.invoice_id`,
  },
  {
    name: 'no_orphan_invoice_lines',
    severity: 'critical',
    because: 'an invoice line with no ledger row behind it charges for a '
      + 'recovery that cannot be evidenced',
    sql: `
      SELECT il.invoice_line_id, il.invoice_id
      FROM invoice_line il
      WHERE il.tenant_id = $1
        AND il.usage_event_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM usage_event ue
          WHERE ue.usage_event_id = il.usage_event_id)`,
  },
  {
    name: 'invoice_totals_match_their_lines',
    severity: 'critical',
    because: 'a header that disagrees with its own lines is a bill the '
      + 'customer can refuse and an auditor cannot reconcile',
    sql: `
      SELECT i.invoice_id, i.invoice_number,
             i.attributed_recovery AS header_recovery,
             COALESCE(sum(il.amount_recovered), 0) AS line_recovery,
             i.contingency_fee AS header_fee,
             COALESCE(sum(il.fee), 0) AS line_fee
      FROM invoice i
      LEFT JOIN invoice_line il ON il.invoice_id = i.invoice_id
      WHERE i.tenant_id = $1
        AND i.status <> 'void'
      GROUP BY i.invoice_id, i.invoice_number, i.attributed_recovery, i.contingency_fee
      HAVING round(COALESCE(sum(il.amount_recovered), 0)::numeric, 2)
               <> round(i.attributed_recovery::numeric, 2)
          OR round(COALESCE(sum(il.fee), 0)::numeric, 2)
               <> round(i.contingency_fee::numeric, 2)`,
  },
  {
    name: 'one_ledger_row_per_payment_event',
    severity: 'critical',
    because: 'the ledger is meant to record each attributed payment once; a '
      + 'duplicate means a re-run appended instead of recognising prior work',
    sql: `
      SELECT payment_event_id, count(*) AS ledger_rows
      FROM usage_event
      WHERE tenant_id = $1 AND payment_event_id IS NOT NULL
      GROUP BY payment_event_id
      HAVING count(*) > 1`,
  },
  {
    name: 'issued_invoice_has_a_number',
    severity: 'error',
    because: 'an issued invoice with no number cannot be referenced in a '
      + 'dispute or matched to a remittance',
    sql: `
      SELECT invoice_id, status FROM invoice
      WHERE tenant_id = $1 AND status = 'issued'
        AND (invoice_number IS NULL OR invoice_number = '')`,
  },
  {
    name: 'invoice_numbers_unique',
    severity: 'critical',
    because: 'two invoices sharing a number is what a concurrent issue race '
      + 'produces, and it makes payment application ambiguous',
    sql: `
      SELECT invoice_number, count(*) AS invoices
      FROM invoice
      WHERE tenant_id = $1 AND invoice_number IS NOT NULL
      GROUP BY invoice_number
      HAVING count(*) > 1`,
  },
  {
    name: 'claim_lines_belong_to_their_claim_tenant',
    severity: 'critical',
    because: 'a line whose tenant differs from its claim is a cross-tenant '
      + 'leak that row-level security would then enforce inconsistently',
    sql: `
      SELECT cl.claim_line_id, cl.tenant_id AS line_tenant, c.tenant_id AS claim_tenant
      FROM claim_line cl JOIN claim c ON c.claim_id = cl.claim_id
      WHERE (cl.tenant_id = $1 OR c.tenant_id = $1)
        AND cl.tenant_id <> c.tenant_id`,
  },
  {
    name: 'recovery_cases_reference_live_claims',
    severity: 'error',
    because: 'a case pointing at a missing claim cannot be appealed and will '
      + 'fail when a packet is built for it',
    sql: `
      SELECT rc.case_id FROM recovery_case rc
      WHERE rc.tenant_id = $1 AND rc.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM claim c WHERE c.claim_id = rc.claim_id)`,
  },
  {
    name: 'remittance_lines_belong_to_their_remittance',
    severity: 'critical',
    because: 'an orphaned remittance line is money the system believes it '
      + 'received with no payer document behind it',
    sql: `
      SELECT rl.remittance_line_id FROM remittance_line rl
      WHERE rl.tenant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM remittance r WHERE r.remittance_id = rl.remittance_id)`,
  },
  {
    name: 'no_duplicate_claims_per_client',
    severity: 'error',
    because: 'ingesting the same file twice must update rather than duplicate; '
      + 'duplicates double-count both the opportunity and the fee',
    sql: `
      SELECT client_id, claim_number_internal, count(*) AS copies
      FROM claim
      WHERE tenant_id = $1 AND claim_number_internal IS NOT NULL
      GROUP BY client_id, claim_number_internal
      HAVING count(*) > 1`,
  },
  {
    name: 'payment_events_have_a_case',
    severity: 'error',
    because: 'an attributed payment with no case cannot be evidenced on a '
      + 'statement, so it must never reach an invoice',
    sql: `
      SELECT pe.payment_event_id FROM payment_event pe
      WHERE pe.tenant_id = $1
        AND pe.case_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM recovery_case rc WHERE rc.case_id = pe.case_id)`,
  },
];

export interface InvariantReport {
  checked: number;
  violations: InvariantViolation[];
  /** True when nothing critical failed. Errors are reported but not fatal. */
  clean: boolean;
}

/** Run every invariant against one tenant and collect what failed. */
export async function checkInvariants(
  db: Queryable, tenantId: UUID, only?: string[],
): Promise<InvariantReport> {
  const selected = only ? INVARIANTS.filter((c) => only.includes(c.name)) : INVARIANTS;
  const violations: InvariantViolation[] = [];

  for (const check of selected) {
    const result = await db.query(check.sql, [tenantId]);
    if (result.rows.length > 0) {
      violations.push({
        invariant: check.name,
        detail: `${result.rows.length} row(s) violate this: ${check.because}`,
        examples: result.rows.slice(0, 5),
        severity: check.severity,
      });
    }
  }

  return {
    checked: selected.length,
    violations,
    clean: !violations.some((v) => v.severity === 'critical'),
  };
}

export function formatInvariantReport(report: InvariantReport): string {
  if (report.violations.length === 0) {
    return `all ${report.checked} invariants hold`;
  }
  const lines = [`${report.violations.length} of ${report.checked} invariants violated:`];
  for (const violation of report.violations) {
    lines.push(`  [${violation.severity}] ${violation.invariant}`);
    lines.push(`      ${violation.detail}`);
    for (const example of violation.examples) {
      lines.push(`      ${JSON.stringify(example)}`);
    }
  }
  return lines.join('\n');
}
