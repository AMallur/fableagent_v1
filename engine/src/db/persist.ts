// ============================================================================
// Persists an EngineResult back to Postgres. Runs inside the caller's
// transaction (service.ts opens it). Every write carries tenant_id so RLS
// and the audit triggers attribute rows correctly.
// ============================================================================

import type { EngineResult, UUID } from '../types.ts';
import type { Queryable } from './snapshot.ts';

export interface PersistStats {
  remitLinesLinked: number;
  remitLinesUnmatched: number;
  claimLinesUpdated: number;
  claimsUpdated: number;
  casesInserted: number;
  casesUpdated: number;
  /** DB ids of cases created in this run (for downstream automation events) */
  createdCaseIds: UUID[];
  updatedCaseIds: UUID[];
}

export async function persistResult(
  db: Queryable, tenantId: UUID, result: EngineResult, jobId: UUID | null,
): Promise<PersistStats> {
  const stats: PersistStats = {
    remitLinesLinked: 0, remitLinesUnmatched: 0, claimLinesUpdated: 0,
    claimsUpdated: 0, casesInserted: 0, casesUpdated: 0,
    createdCaseIds: [], updatedCaseIds: [],
  };

  // ---- STEP 1 outcome: remit line links / unmatched flags -------------------
  for (const m of result.matches) {
    await db.query(
      `UPDATE remittance_line
       SET claim_id = $1, claim_line_id = $2, match_method = $3, matched_at = now()
       WHERE remittance_line_id = $4 AND tenant_id = $5`,
      [m.claimId, m.claimLineId, m.method, m.remittanceLineId, tenantId],
    );
    stats.remitLinesLinked += 1;
  }
  for (const u of result.unmatchedRemitLines) {
    await db.query(
      `UPDATE remittance_line SET match_method = 'unmatched', matched_at = now()
       WHERE remittance_line_id = $1 AND tenant_id = $2`,
      [u.remittanceLineId, tenantId],
    );
    stats.remitLinesUnmatched += 1;
  }

  // ---- STEP 2/3 outcome: claim line amounts, pricing provenance, denials ----
  for (const l of result.claimLineUpdates) {
    await db.query(
      `UPDATE claim_line
       SET paid_amount = COALESCE($1, paid_amount),
           allowed_amount = COALESCE($2, allowed_amount),
           expected_amount = COALESCE($3, expected_amount),
           expected_source = COALESCE($4, expected_source),
           denial_reason_code = COALESCE($5, denial_reason_code),
           denial_reason_description = COALESCE($6, denial_reason_description),
           line_status = COALESCE($7, line_status)
       WHERE claim_line_id = $8 AND tenant_id = $9`,
      [l.paidAmount, l.allowedAmount, l.expectedAmount, l.expectedSource ?? null,
       l.denialReasonCode, l.denialReasonDescription, l.lineStatus,
       l.claimLineId, tenantId],
    );
    stats.claimLinesUpdated += 1;
  }

  for (const s of result.claimStatusUpdates) {
    await db.query(
      `UPDATE claim SET claim_status = $1 WHERE claim_id = $2 AND tenant_id = $3`,
      [s.toStatus, s.claimId, tenantId],
    );
    stats.claimsUpdated += 1;
  }

  // ---- STEP 6 outcome: recovery cases ---------------------------------------
  const jobNote = jobId ? ` (job ${jobId})` : '';
  for (const c of result.casesCreated) {
    const inserted = await db.query(
      `INSERT INTO recovery_case
         (tenant_id, client_id, claim_id, claim_line_id, case_type,
          denial_reason_code, denial_category, expected_amount, paid_amount,
          recovery_opportunity, confidence_score, priority_level, status,
          deadline_date, auto_created, recovery_likelihood, recommended_action,
          appealability_score, auto_action, expired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,true,$14,$15,$16,$17,$18)
       RETURNING case_id`,
      [tenantId, c.clientId, c.claimId, c.claimLineId, c.caseType,
       c.denialReasonCode, c.denialCategory, c.expectedAmount, c.paidAmount,
       c.recoveryOpportunity, c.confidenceScore, c.priorityLevel,
       c.deadlineDate, c.recoveryLikelihood, c.recommendedAction,
       c.appealabilityScore, c.autoAction, c.expired],
    );
    await db.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'note', true, $3)`,
      [tenantId, inserted.rows[0].case_id,
       `Case auto-created by detection engine${jobNote}: `
       + `${c.caseType}${c.denialReasonCode ? ` [${c.denialReasonCode}]` : ''}, `
       + `recovery opportunity $${c.recoveryOpportunity.toFixed(2)}, `
       + `score ${c.appealabilityScore}/100${c.expired ? ', DEADLINE EXPIRED' : ''}`],
    );
    stats.casesInserted += 1;
    stats.createdCaseIds.push(inserted.rows[0].case_id);
  }

  for (const c of result.casesUpdated) {
    await db.query(
      `UPDATE recovery_case
       SET expected_amount = $1, paid_amount = $2, recovery_opportunity = $3,
           confidence_score = $4, appealability_score = $5,
           recovery_likelihood = $6, recommended_action = $7,
           priority_level = $8, deadline_date = COALESCE(deadline_date, $9),
           auto_action = $10
       WHERE case_id = $11 AND tenant_id = $12`,
      [c.expectedAmount, c.paidAmount, c.recoveryOpportunity,
       c.confidenceScore, c.appealabilityScore, c.recoveryLikelihood,
       c.recommendedAction, c.priorityLevel, c.deadlineDate, c.autoAction,
       c.existingCaseId, tenantId],
    );
    await db.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'note', true, $3)`,
      [tenantId, c.existingCaseId,
       `Case refreshed by detection engine${jobNote}: `
       + `recovery opportunity now $${c.recoveryOpportunity.toFixed(2)}, `
       + `score ${c.appealabilityScore}/100`],
    );
    stats.casesUpdated += 1;
    if (c.existingCaseId) stats.updatedCaseIds.push(c.existingCaseId);
  }

  return stats;
}
