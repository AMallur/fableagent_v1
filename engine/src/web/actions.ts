// ============================================================================
// Write-side actions for the interface. Every mutation verifies the target
// row belongs to the session's tenant/clients, writes a case_action entry
// where the timeline should show it, and runs inside a transaction when more
// than one row changes.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { Session } from './auth.ts';
import type { Scope } from './queries.ts';
import type { DocumentStore } from '../appeals/storage.ts';
import { DENIAL_TAXONOMY, normalizeDenialCode } from '../taxonomy.ts';
import { addDays, daysBetween, makeConfig } from '../config.ts';
import { priorityFor } from '../steps/step5_scoring.ts';
import { generateAppealPackets } from '../appeals/service.ts';
import { createNotification } from '../automation/notify.ts';

async function tx<T>(pool: PoolLike, tenantId: UUID, work: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ownCase(db: Queryable, s: Scope, caseId: UUID): Promise<{ claim_id: UUID; client_id: UUID }> {
  const rows = await db.query(
    `SELECT claim_id, client_id FROM recovery_case
     WHERE case_id = $1 AND tenant_id = $2 AND client_id = ANY($3) AND deleted_at IS NULL`,
    [caseId, s.tenantId, s.clientIds],
  );
  if (!rows.rows[0]) throw Object.assign(new Error('case not found'), { status: 404 });
  return rows.rows[0];
}

async function logAction(
  db: Queryable, tenantId: UUID, caseId: UUID, userId: UUID,
  actionType: string, notes: string, relatedDocumentId?: UUID,
): Promise<void> {
  await db.query(
    `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_user_id, notes, related_document_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, caseId, actionType, userId, notes, relatedDocumentId ?? null],
  );
}

// ---------------------------------------------------------------------------
// case actions: note, payer call, assign, status
// ---------------------------------------------------------------------------

export async function addNote(pool: PoolLike, sess: Session, s: Scope, caseId: UUID, notes: string) {
  return tx(pool, s.tenantId, async (db) => {
    await ownCase(db, s, caseId);
    await logAction(db, s.tenantId, caseId, sess.userId, 'note', notes);
    return { ok: true };
  });
}

export async function logPayerCall(
  pool: PoolLike, sess: Session, s: Scope, caseId: UUID,
  outcome: string, notes: string,
) {
  return tx(pool, s.tenantId, async (db) => {
    await ownCase(db, s, caseId);
    await logAction(
      db, s.tenantId, caseId, sess.userId, 'payer_call_logged',
      `Payer call — outcome: ${outcome}${notes ? ` | ${notes}` : ''}`,
    );
    return { ok: true };
  });
}

export async function assignCase(
  pool: PoolLike, sess: Session, s: Scope, caseId: UUID, userId: UUID | null,
) {
  return tx(pool, s.tenantId, async (db) => {
    await ownCase(db, s, caseId);
    const name = userId ? (await db.query(
      `SELECT TRIM(first_name || ' ' || last_name) AS name FROM app_user
       WHERE user_id = $1 AND tenant_id = $2`, [userId, s.tenantId],
    )).rows[0]?.name : null;
    if (userId && !name) throw Object.assign(new Error('user not found'), { status: 400 });
    await db.query(
      `UPDATE recovery_case SET assigned_to_user_id = $1 WHERE case_id = $2 AND tenant_id = $3`,
      [userId, caseId, s.tenantId],
    );
    await logAction(db, s.tenantId, caseId, sess.userId, 'status_changed',
      userId ? `Assigned to ${name}` : 'Unassigned');
    if (userId && userId !== sess.userId) {
      await createNotification(db, {
        tenantId: s.tenantId, userId, type: 'case_assigned',
        title: `Case assigned to you by ${sess.name}`,
        caseId,
      });
    }
    return { ok: true, assignedTo: name };
  });
}

const VALID_STATUSES = new Set([
  'open', 'in_progress', 'submitted', 'pending_payer', 'won', 'lost', 'closed_no_action',
]);

export async function setCaseStatus(
  pool: PoolLike, sess: Session, s: Scope, caseId: UUID, status: string,
) {
  if (!VALID_STATUSES.has(status)) {
    throw Object.assign(new Error(`invalid status: ${status}`), { status: 400 });
  }
  return tx(pool, s.tenantId, async (db) => {
    await ownCase(db, s, caseId);
    await db.query(
      `UPDATE recovery_case SET status = $1 WHERE case_id = $2 AND tenant_id = $3`,
      [status, caseId, s.tenantId],
    );
    await logAction(db, s.tenantId, caseId, sess.userId, 'status_changed', `Status changed to ${status}`);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// bulk actions
// ---------------------------------------------------------------------------

export async function bulkAction(
  pool: PoolLike, sess: Session, s: Scope,
  caseIds: UUID[], action: { assignTo?: UUID | null; status?: string },
) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw Object.assign(new Error('no cases selected'), { status: 400 });
  }
  if (action.status && !VALID_STATUSES.has(action.status)) {
    throw Object.assign(new Error(`invalid status: ${action.status}`), { status: 400 });
  }
  return tx(pool, s.tenantId, async (db) => {
    const owned = await db.query(
      `SELECT case_id FROM recovery_case
       WHERE case_id = ANY($1) AND tenant_id = $2 AND client_id = ANY($3) AND deleted_at IS NULL`,
      [caseIds, s.tenantId, s.clientIds],
    );
    const ids = owned.rows.map((r) => r.case_id);
    if (ids.length === 0) return { ok: true, updated: 0 };

    if (action.assignTo !== undefined) {
      await db.query(
        `UPDATE recovery_case SET assigned_to_user_id = $1 WHERE case_id = ANY($2)`,
        [action.assignTo, ids],
      );
    }
    if (action.status) {
      await db.query(
        `UPDATE recovery_case SET status = $1 WHERE case_id = ANY($2)`,
        [action.status, ids],
      );
    }
    const label = action.status
      ? `Bulk status change to ${action.status}`
      : action.assignTo ? 'Bulk assignment' : 'Bulk unassignment';
    for (const id of ids) {
      await logAction(db, s.tenantId, id, sess.userId, 'status_changed', label);
    }
    if (action.assignTo && action.assignTo !== sess.userId) {
      await createNotification(db, {
        tenantId: s.tenantId, userId: action.assignTo, type: 'new_cases',
        title: `${ids.length} case(s) assigned to your queue by ${sess.name}`,
      });
    }
    return { ok: true, updated: ids.length };
  });
}

// ---------------------------------------------------------------------------
// documents: upload + packet refresh
// ---------------------------------------------------------------------------

const UPLOADABLE_TYPES = new Set([
  'appeal_letter', 'eob', 'medical_record', 'authorization', 'corrected_claim',
  'contract', 'fee_schedule', 'payer_policy', 'other',
]);

export async function uploadCaseDocument(
  pool: PoolLike, sess: Session, s: Scope, store: DocumentStore,
  caseId: UUID, fileName: string, documentType: string, content: Buffer,
) {
  if (!UPLOADABLE_TYPES.has(documentType)) {
    throw Object.assign(new Error(`invalid document type: ${documentType}`), { status: 400 });
  }
  if (!content.length) throw Object.assign(new Error('empty upload'), { status: 400 });

  const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'upload.bin';
  const documentId = await tx(pool, s.tenantId, async (db) => {
    const c = await ownCase(db, s, caseId);
    const storagePath = await store.put(`${s.tenantId}/cases/${caseId}/${Date.now()}-${safeName}`, content);
    const doc = await db.query(
      `INSERT INTO document (tenant_id, client_id, case_id, document_type, file_name,
                             storage_path, uploaded_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user_upload') RETURNING document_id`,
      [s.tenantId, c.client_id, caseId, documentType, safeName, storagePath, sess.userId],
    );
    await logAction(db, s.tenantId, caseId, sess.userId, 'document_uploaded',
      `Uploaded ${documentType}: ${safeName}`, doc.rows[0].document_id);
    return doc.rows[0].document_id as UUID;
  });

  // refresh the case's draft packet so the new document can flip it to ready
  const refresh = await generateAppealPackets(pool, {
    tenantId: s.tenantId, caseIds: [caseId], store,
  }).catch(() => null);

  return {
    ok: true, documentId,
    packet: refresh?.packets[0] ? {
      packetId: refresh.packets[0].packetId,
      packetStatus: refresh.packets[0].packetStatus,
      missingDocumentTypes: refresh.packets[0].missingDocumentTypes,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// packet submission (electronic mark-submitted / manual mailed-faxed)
// ---------------------------------------------------------------------------

export async function submitPacket(
  pool: PoolLike, sess: Session, s: Scope, packetId: UUID,
  opts: { method?: string; payerReference?: string; manual?: boolean },
) {
  return tx(pool, s.tenantId, async (db) => {
    const p = await db.query(
      `SELECT ap.packet_id, ap.case_id, ap.packet_status, ap.submission_method,
              ap.missing_document_types
       FROM appeal_packet ap JOIN recovery_case rc ON rc.case_id = ap.case_id
       WHERE ap.packet_id = $1 AND ap.tenant_id = $2 AND rc.client_id = ANY($3)
         AND ap.deleted_at IS NULL`,
      [packetId, s.tenantId, s.clientIds],
    );
    const packet = p.rows[0];
    if (!packet) throw Object.assign(new Error('packet not found'), { status: 404 });
    if (packet.packet_status === 'submitted' || packet.packet_status === 'acknowledged') {
      throw Object.assign(new Error('packet already submitted'), { status: 409 });
    }
    const method = opts.method ?? packet.submission_method ?? 'mail';
    const electronic = ['portal', 'clearinghouse'].includes(method);
    if (!opts.manual && !electronic) {
      throw Object.assign(
        new Error(`method ${method} requires manual submission — use mark as mailed/faxed`),
        { status: 400 },
      );
    }
    if (packet.packet_status !== 'ready' && !opts.manual) {
      throw Object.assign(
        new Error(`packet is ${packet.packet_status}; missing: ${(packet.missing_document_types ?? []).join(', ')}`),
        { status: 409 },
      );
    }

    await db.query(
      `UPDATE appeal_packet
       SET packet_status = 'submitted', submitted_at = now(), submission_method = $1,
           payer_reference_number = COALESCE($2, payer_reference_number)
       WHERE packet_id = $3 AND tenant_id = $4`,
      [method, opts.payerReference ?? null, packetId, s.tenantId],
    );
    await db.query(
      `UPDATE recovery_case SET status = 'submitted'
       WHERE case_id = $1 AND tenant_id = $2 AND status IN ('open', 'in_progress')`,
      [packet.case_id, s.tenantId],
    );
    await logAction(db, s.tenantId, packet.case_id, sess.userId, 'appeal_submitted',
      opts.manual
        ? `Appeal marked as sent via ${method}`
        : `Appeal submitted electronically via ${method}`);
    return { ok: true, caseId: packet.case_id, method };
  });
}

// ---------------------------------------------------------------------------
// manual case creation (appeal packet builder)
// ---------------------------------------------------------------------------

export interface ManualCaseInput {
  claimId: UUID;
  claimLineId?: UUID | null;
  caseType: string;
  denialReasonCode?: string | null;
  deadlineDate?: string | null;
  assignTo?: UUID | null;
  notes?: string | null;
}

/** Builder step 2: recommendation for a denial code + suggested deadline. */
export async function recommendation(
  db: Queryable, s: Scope, code: string | null, payerId: UUID | null, asOf: string,
) {
  const normalized = normalizeDenialCode(code);
  const entry = normalized ? DENIAL_TAXONOMY[normalized] : null;
  let deadlineDays = 90;
  if (payerId) {
    const p = await db.query(
      `SELECT appeal_deadline_days FROM payer WHERE payer_id = $1`, [payerId]);
    deadlineDays = p.rows[0]?.appeal_deadline_days ?? 90;
  }
  return {
    code: normalized,
    known: !!entry,
    category: entry?.category ?? null,
    caseType: entry?.caseType ?? null,
    recommendedAction: entry?.recommendedAction
      ?? 'Review remittance detail and classify manually',
    baseLikelihood: entry?.baseLikelihood ?? null,
    suggestedDeadline: addDays(asOf, deadlineDays),
    deadlineDays,
  };
}

export async function createManualCase(
  pool: PoolLike, sess: Session, s: Scope, input: ManualCaseInput, asOf: string,
) {
  return tx(pool, s.tenantId, async (db) => {
    const claim = await db.query(
      `SELECT cl.claim_id, cl.client_id, cl.payer_id FROM claim cl
       WHERE cl.claim_id = $1 AND cl.tenant_id = $2 AND cl.client_id = ANY($3)
         AND cl.deleted_at IS NULL`,
      [input.claimId, s.tenantId, s.clientIds],
    );
    if (!claim.rows[0]) throw Object.assign(new Error('claim not found'), { status: 404 });
    const { client_id, payer_id } = claim.rows[0];

    const dupe = await db.query(
      `SELECT case_id FROM recovery_case
       WHERE claim_id = $1 AND COALESCE(claim_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         AND status IN ('open', 'in_progress', 'submitted', 'pending_payer')
         AND deleted_at IS NULL`,
      [input.claimId, input.claimLineId ?? null],
    );
    if (dupe.rows[0]) {
      throw Object.assign(
        new Error(`an open case already exists for this claim line (${dupe.rows[0].case_id})`),
        { status: 409 },
      );
    }

    // amounts from the targeted line(s)
    const amounts = await db.query(
      `SELECT COALESCE(sum(expected_amount), 0) AS expected,
              COALESCE(sum(paid_amount), 0) AS paid,
              COALESCE(sum(billed_amount), 0) AS billed
       FROM claim_line WHERE claim_id = $1 AND deleted_at IS NULL
         AND ($2::uuid IS NULL OR claim_line_id = $2)`,
      [input.claimId, input.claimLineId ?? null],
    );
    const a = amounts.rows[0];
    const expected = Number(a.expected) || null;
    const paid = Number(a.paid);
    const basis = expected ?? Number(a.billed);
    const recovery = Math.max(0, Math.round((basis - paid) * 100) / 100);

    const normalized = normalizeDenialCode(input.denialReasonCode);
    const entry = normalized ? DENIAL_TAXONOMY[normalized] : null;
    const deadline = input.deadlineDate ?? null;
    const cfg = makeConfig(asOf);
    const days = deadline ? daysBetween(asOf, deadline) : null;
    const priority = priorityFor(
      { config: cfg } as any, recovery, days, days != null && days < 0,
    );

    const inserted = await db.query(
      `INSERT INTO recovery_case
         (tenant_id, client_id, claim_id, claim_line_id, case_type, denial_reason_code,
          denial_category, expected_amount, paid_amount, recovery_opportunity,
          priority_level, status, deadline_date, assigned_to_user_id, auto_created,
          recommended_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13,false,$14)
       RETURNING case_id`,
      [s.tenantId, client_id, input.claimId, input.claimLineId ?? null,
       input.caseType, normalized, entry?.category ?? null,
       expected, paid, recovery, priority, deadline, input.assignTo ?? null,
       entry?.recommendedAction ?? null],
    );
    const caseId = inserted.rows[0].case_id as UUID;
    await logAction(db, s.tenantId, caseId, sess.userId, 'note',
      `Case created manually via builder (${input.caseType}`
      + `${normalized ? `, ${normalized}` : ''})${input.notes ? `: ${input.notes}` : ''}`);
    return { ok: true, caseId, recovery, priority, payerId: payer_id };
  });
}

// ---------------------------------------------------------------------------
// reconciliation: manual payment match
// ---------------------------------------------------------------------------

export async function manualMatch(
  pool: PoolLike, sess: Session, s: Scope,
  input: { caseId: UUID; remittanceId?: UUID | null; amount: number; date: string; notes?: string; markWon?: boolean },
) {
  if (!(input.amount > 0)) throw Object.assign(new Error('amount must be positive'), { status: 400 });
  return tx(pool, s.tenantId, async (db) => {
    const c = await ownCase(db, s, input.caseId);
    await db.query(
      `INSERT INTO payment_event
         (tenant_id, case_id, remittance_id, claim_id, amount_recovered, payment_date,
          matched_automatically, verified_by_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8)`,
      [s.tenantId, input.caseId, input.remittanceId ?? null, c.claim_id,
       input.amount, input.date, sess.userId, input.notes ?? null],
    );
    if (input.markWon) {
      await db.query(
        `UPDATE recovery_case SET status = 'won' WHERE case_id = $1 AND tenant_id = $2`,
        [input.caseId, s.tenantId],
      );
    }
    await logAction(db, s.tenantId, input.caseId, sess.userId, 'payment_received',
      `Payment of $${input.amount.toFixed(2)} matched manually`
      + `${input.markWon ? '; case marked won' : ''}`);
    return { ok: true };
  });
}
