// ============================================================================
// The appeal generation service (job type: generate_appeals).
//
//   generateAppealPackets(pool, { tenantId, clientId?, asOf?, store? })
//
// For each open/in_progress case without a finalized packet:
//   1. generate a corrected-claim record when the denial code calls for one
//   2. build the document plan (assembly.ts)
//   3. generate the appeal letter, write generated documents to the store,
//      insert DOCUMENT rows, link everything to the APPEAL_PACKET
//   4. packet_status ready/draft, auto_submit / needs_review flags
//   5. case_action note on the case
// Cases with an existing draft packet are refreshed in place.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { AppealCaseContext, DocumentPlan } from './types.ts';
import { loadAppealContexts, type AppealScope } from './context.ts';
import { buildDocumentPlan } from './assembly.ts';
import { generateAppealLetter } from './letter.ts';
import { correctionDocument, generateCorrection } from './corrected_claim.ts';
import { FileSystemDocumentStore, type DocumentStore } from './storage.ts';

export interface GenerateAppealsParams extends AppealScope {
  store?: DocumentStore;
}

export interface PacketOutcome {
  caseId: UUID;
  packetId: UUID;
  refreshed: boolean;
  packetStatus: string;
  appealType: string;
  submissionMethod: string;
  autoSubmit: boolean;
  needsReview: boolean;
  needsReviewReasons: string[];
  missingDocumentTypes: string[];
  documentCount: number;
  correctedClaimId: UUID | null;
}

export interface GenerateAppealsResult {
  jobId: UUID;
  packets: PacketOutcome[];
  summary: {
    casesProcessed: number;
    packetsCreated: number;
    packetsRefreshed: number;
    ready: number;
    draft: number;
    autoSubmit: number;
    needsReview: number;
    correctionsCreated: number;
  };
}

export async function generateAppealPackets(
  pool: PoolLike, params: GenerateAppealsParams,
): Promise<GenerateAppealsResult> {
  const store = params.store ?? new FileSystemDocumentStore();

  // One connection for the whole job, tenant context set once — a bare
  // pool.query() call grabs a random pool connection with no tenant
  // context set, which RLS would treat as "no tenant" and hide/reject
  // rows even though the query's own explicit WHERE clauses are correct.
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [params.tenantId]);

    const job = await client.query(
      `INSERT INTO system_job (tenant_id, client_id, job_type, status, started_at)
       VALUES ($1, $2, 'generate_appeals', 'running', now()) RETURNING job_id`,
      [params.tenantId, params.clientId ?? null],
    );
    const jobId: UUID = job.rows[0].job_id;

    try {
      const contexts = await loadAppealContexts(client, params);
      const packets: PacketOutcome[] = [];

      try {
        await client.query('BEGIN');
        for (const ctx of contexts) {
          packets.push(await buildPacket(client, store, params.tenantId, ctx));
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      const summary = {
        casesProcessed: contexts.length,
        packetsCreated: packets.filter((p) => !p.refreshed).length,
        packetsRefreshed: packets.filter((p) => p.refreshed).length,
        ready: packets.filter((p) => p.packetStatus === 'ready').length,
        draft: packets.filter((p) => p.packetStatus === 'draft').length,
        autoSubmit: packets.filter((p) => p.autoSubmit).length,
        needsReview: packets.filter((p) => p.needsReview).length,
        correctionsCreated: packets.filter((p) => p.correctedClaimId).length,
      };

      await client.query(
        `UPDATE system_job
         SET status = 'completed', completed_at = now(),
             records_processed = $1, errors_count = 0, log_output = $2
         WHERE job_id = $3`,
        [contexts.length, JSON.stringify(summary), jobId],
      );

      return { jobId, packets, summary };
    } catch (err) {
      await client.query(
        `UPDATE system_job
         SET status = 'failed', completed_at = now(), errors_count = 1, log_output = $1
         WHERE job_id = $2`,
        [String(err instanceof Error ? err.stack ?? err.message : err), jobId],
      ).catch(() => { /* keep the original error */ });
      throw err;
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

async function buildPacket(
  db: Queryable, store: DocumentStore, tenantId: UUID, ctx: AppealCaseContext,
): Promise<PacketOutcome> {
  // 1. corrected claim (CO-4/5/6) — one active record per case
  const correction = generateCorrection(ctx);
  let correctedClaimId: UUID | null = null;
  if (correction) {
    const existing = await db.query(
      `SELECT corrected_claim_id FROM corrected_claim
       WHERE case_id = $1 AND status <> 'rejected' AND deleted_at IS NULL LIMIT 1`,
      [ctx.caseId],
    );
    if (existing.rows[0]) {
      correctedClaimId = existing.rows[0].corrected_claim_id;
    } else {
      const inserted = await db.query(
        `INSERT INTO corrected_claim
           (tenant_id, case_id, claim_id, claim_line_id, original_fields,
            corrected_fields, correction_reason, confidence_score, needs_manual_review)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING corrected_claim_id`,
        [tenantId, ctx.caseId, ctx.claimId, correction.claimLineId,
         JSON.stringify(correction.originalFields), JSON.stringify(correction.correctedFields),
         correction.reason, correction.confidenceScore, correction.needsManualReview],
      );
      correctedClaimId = inserted.rows[0].corrected_claim_id;
    }
  }

  // 2. plan
  const plan: DocumentPlan = buildDocumentPlan(ctx, correction);

  // 3. letter (attachment list = everything else in the packet)
  const attachmentNames = [
    ...plan.documents.map((d) => (d.kind === 'existing' ? d.fileName : d.fileName)),
    ...(correction ? [correctionDocument(ctx, correction).fileName] : []),
  ];
  const letter = generateAppealLetter(ctx, attachmentNames);

  // 4. packet row (create or refresh the existing draft)
  let packetId: UUID;
  const refreshed = ctx.existingDraftPacketId != null;
  if (refreshed) {
    packetId = ctx.existingDraftPacketId!;
    await db.query(
      `UPDATE appeal_packet
       SET packet_status = $1, appeal_type = $2, submission_method = $3,
           auto_submit = $4, needs_review = $5, needs_review_reasons = $6,
           missing_document_types = $7
       WHERE packet_id = $8 AND tenant_id = $9`,
      [plan.packetStatus, plan.appealType, plan.submissionMethod,
       plan.autoSubmit, plan.needsReview, plan.needsReviewReasons,
       plan.missingDocumentTypes, packetId, tenantId],
    );
    await db.query(
      `DELETE FROM appeal_packet_document WHERE packet_id = $1 AND tenant_id = $2`,
      [packetId, tenantId],
    );
  } else {
    const inserted = await db.query(
      `INSERT INTO appeal_packet
         (tenant_id, case_id, packet_status, appeal_type, submission_method,
          auto_submit, needs_review, needs_review_reasons, missing_document_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING packet_id`,
      [tenantId, ctx.caseId, plan.packetStatus, plan.appealType, plan.submissionMethod,
       plan.autoSubmit, plan.needsReview, plan.needsReviewReasons, plan.missingDocumentTypes],
    );
    packetId = inserted.rows[0].packet_id;
  }

  // 5. documents: letter first, then supporting docs, then correction summary
  let sortOrder = 0;
  const link = async (documentId: UUID) => {
    await db.query(
      `INSERT INTO appeal_packet_document (packet_id, document_id, tenant_id, sort_order)
       VALUES ($1, $2, $3, $4) ON CONFLICT (packet_id, document_id) DO NOTHING`,
      [packetId, documentId, tenantId, sortOrder++],
    );
  };
  const storeAndRecord = async (
    documentType: string, fileName: string, content: string,
  ): Promise<UUID> => {
    const storagePath = await store.put(
      `${tenantId}/cases/${ctx.caseId}/${fileName}`, content,
    );
    const doc = await db.query(
      `INSERT INTO document
         (tenant_id, client_id, case_id, document_type, file_name, storage_path, source)
       VALUES ($1,$2,$3,$4,$5,$6,'system_generated') RETURNING document_id`,
      [tenantId, ctx.clientId, ctx.caseId, documentType, fileName, storagePath],
    );
    return doc.rows[0].document_id;
  };

  const letterDocId = await storeAndRecord('appeal_letter', letter.fileName, letter.content);
  await link(letterDocId);
  for (const planned of plan.documents) {
    if (planned.kind === 'existing') await link(planned.documentId);
    else await link(await storeAndRecord(planned.documentType, planned.fileName, planned.content));
  }
  if (correction) {
    const cd = correctionDocument(ctx, correction);
    await link(await storeAndRecord('corrected_claim', cd.fileName, cd.content));
  }

  await db.query(
    `UPDATE appeal_packet SET letter_document_id = $1 WHERE packet_id = $2 AND tenant_id = $3`,
    [letterDocId, packetId, tenantId],
  );

  // 6. activity note
  await db.query(
    `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes, related_document_id)
     VALUES ($1, $2, 'note', true, $3, $4)`,
    [tenantId, ctx.caseId,
     `Appeal packet ${refreshed ? 'refreshed' : 'generated'}: ${plan.appealType} via ${plan.submissionMethod}, `
     + `status ${plan.packetStatus}`
     + (plan.missingDocumentTypes.length ? ` (missing: ${plan.missingDocumentTypes.join(', ')})` : '')
     + (plan.autoSubmit ? ', queued for auto-submission' : '')
     + (plan.needsReview ? `, needs review: ${plan.needsReviewReasons.join('; ')}` : ''),
     letterDocId],
  );

  return {
    caseId: ctx.caseId,
    packetId,
    refreshed,
    packetStatus: plan.packetStatus,
    appealType: plan.appealType,
    submissionMethod: plan.submissionMethod,
    autoSubmit: plan.autoSubmit,
    needsReview: plan.needsReview,
    needsReviewReasons: plan.needsReviewReasons,
    missingDocumentTypes: plan.missingDocumentTypes,
    documentCount: sortOrder,
    correctedClaimId,
  };
}
