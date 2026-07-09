// ============================================================================
// MODULE: SUBMISSION QUEUE + document retrieval.
//
// loadSubmissionQueue: ready packets sorted by priority then deadline, with
// the required action computed per packet. Queries run as the caller, so RLS
// applies normally.
//
// findDocuments / findPackets: retrieval by case, patient, payer, and date
// range (patient/payer resolve through case -> claim -> encounter).
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

// ---------------------------------------------------------------------------
// submission queue
// ---------------------------------------------------------------------------

export interface QueueItem {
  packetId: UUID;
  caseId: UUID;
  patientName: string;
  payerName: string;
  appealType: string;
  recoveryAmount: number | null;
  deadlineDate: string | null;
  priorityLevel: string;
  submissionMethod: string | null;
  autoSubmit: boolean;
  needsReview: boolean;
  needsReviewReasons: string[];
  requiredAction: string;
}

export function requiredAction(item: {
  autoSubmit: boolean; needsReview: boolean;
  needsReviewReasons: string[]; submissionMethod: string | null;
}): string {
  if (item.needsReview) {
    return `review required: ${item.needsReviewReasons.join('; ') || 'manual review'}`;
  }
  if (item.autoSubmit) {
    return `auto-submit via ${item.submissionMethod ?? 'configured method'}`;
  }
  return `submit manually via ${item.submissionMethod ?? 'mail'}`;
}

export async function loadSubmissionQueue(
  db: Queryable, scope: { tenantId: UUID; clientId?: UUID },
): Promise<QueueItem[]> {
  const params: unknown[] = [scope.tenantId];
  let filter = '';
  if (scope.clientId) { params.push(scope.clientId); filter = ` AND rc.client_id = $${params.length}`; }

  const rows = await db.query(
    `SELECT ap.packet_id, ap.case_id, ap.appeal_type, ap.submission_method,
            ap.auto_submit, ap.needs_review, ap.needs_review_reasons,
            rc.recovery_opportunity, rc.priority_level, rc.deadline_date,
            pat.first_name, pat.last_name, py.payer_name
     FROM appeal_packet ap
     JOIN recovery_case rc ON rc.case_id = ap.case_id
     JOIN claim cl         ON cl.claim_id = rc.claim_id
     JOIN encounter e      ON e.encounter_id = cl.encounter_id
     JOIN patient pat      ON pat.patient_id = e.patient_id
     JOIN payer py         ON py.payer_id = cl.payer_id
     WHERE ap.tenant_id = $1 ${filter}
       AND ap.packet_status = 'ready'
       AND ap.deleted_at IS NULL AND rc.deleted_at IS NULL
     ORDER BY rc.priority_level, rc.deadline_date ASC NULLS LAST, rc.recovery_opportunity DESC`,
    params,
  );

  return rows.rows.map((r) => {
    const base = {
      autoSubmit: r.auto_submit,
      needsReview: r.needs_review,
      needsReviewReasons: r.needs_review_reasons ?? [],
      submissionMethod: r.submission_method,
    };
    return {
      packetId: r.packet_id,
      caseId: r.case_id,
      patientName: `${r.first_name} ${r.last_name}`,
      payerName: r.payer_name,
      appealType: r.appeal_type,
      recoveryAmount: num(r.recovery_opportunity),
      deadlineDate: iso(r.deadline_date),
      priorityLevel: r.priority_level,
      ...base,
      requiredAction: requiredAction(base),
    };
  });
}

// ---------------------------------------------------------------------------
// document / packet retrieval
// ---------------------------------------------------------------------------

export interface DocumentFilter {
  tenantId: UUID;
  caseId?: UUID;
  patientId?: UUID;
  payerId?: UUID;
  documentType?: string;
  uploadedFrom?: string;   // ISO date, inclusive
  uploadedTo?: string;     // ISO date, inclusive
}

export interface DocumentRecord {
  documentId: UUID;
  caseId: UUID | null;
  clientId: UUID;
  documentType: string;
  fileName: string;
  storagePath: string;
  source: string;
  uploadedAt: string;
}

export async function findDocuments(
  db: Queryable, filter: DocumentFilter,
): Promise<DocumentRecord[]> {
  const params: unknown[] = [filter.tenantId];
  const where: string[] = ['d.tenant_id = $1', 'd.deleted_at IS NULL'];

  if (filter.caseId) { params.push(filter.caseId); where.push(`d.case_id = $${params.length}`); }
  if (filter.documentType) { params.push(filter.documentType); where.push(`d.document_type = $${params.length}`); }
  if (filter.uploadedFrom) { params.push(filter.uploadedFrom); where.push(`d.uploaded_at >= $${params.length}::date`); }
  if (filter.uploadedTo) { params.push(filter.uploadedTo); where.push(`d.uploaded_at < ($${params.length}::date + 1)`); }
  if (filter.patientId) {
    params.push(filter.patientId);
    where.push(`d.case_id IN (
      SELECT rc.case_id FROM recovery_case rc
      JOIN claim cl ON cl.claim_id = rc.claim_id
      JOIN encounter e ON e.encounter_id = cl.encounter_id
      WHERE e.patient_id = $${params.length})`);
  }
  if (filter.payerId) {
    params.push(filter.payerId);
    where.push(`d.case_id IN (
      SELECT rc.case_id FROM recovery_case rc
      JOIN claim cl ON cl.claim_id = rc.claim_id
      WHERE cl.payer_id = $${params.length})`);
  }

  const rows = await db.query(
    `SELECT d.document_id, d.case_id, d.client_id, d.document_type, d.file_name,
            d.storage_path, d.source, d.uploaded_at
     FROM document d
     WHERE ${where.join(' AND ')}
     ORDER BY d.uploaded_at DESC`,
    params,
  );
  return rows.rows.map((r) => ({
    documentId: r.document_id,
    caseId: r.case_id,
    clientId: r.client_id,
    documentType: r.document_type,
    fileName: r.file_name,
    storagePath: r.storage_path,
    source: r.source,
    uploadedAt: r.uploaded_at instanceof Date ? r.uploaded_at.toISOString() : String(r.uploaded_at),
  }));
}

export interface PacketFilter {
  tenantId: UUID;
  caseId?: UUID;
  patientId?: UUID;
  payerId?: UUID;
  packetStatus?: string;
  createdFrom?: string;
  createdTo?: string;
}

export async function findPackets(db: Queryable, filter: PacketFilter): Promise<any[]> {
  const params: unknown[] = [filter.tenantId];
  const where: string[] = ['ap.tenant_id = $1', 'ap.deleted_at IS NULL'];

  if (filter.caseId) { params.push(filter.caseId); where.push(`ap.case_id = $${params.length}`); }
  if (filter.packetStatus) { params.push(filter.packetStatus); where.push(`ap.packet_status = $${params.length}`); }
  if (filter.createdFrom) { params.push(filter.createdFrom); where.push(`ap.created_at >= $${params.length}::date`); }
  if (filter.createdTo) { params.push(filter.createdTo); where.push(`ap.created_at < ($${params.length}::date + 1)`); }
  if (filter.patientId) { params.push(filter.patientId); where.push(`e.patient_id = $${params.length}`); }
  if (filter.payerId) { params.push(filter.payerId); where.push(`cl.payer_id = $${params.length}`); }

  const rows = await db.query(
    `SELECT ap.packet_id, ap.case_id, ap.packet_status, ap.appeal_type,
            ap.submission_method, ap.auto_submit, ap.needs_review, ap.created_at,
            pat.first_name || ' ' || pat.last_name AS patient_name,
            py.payer_name,
            (SELECT count(*) FROM appeal_packet_document apd
             WHERE apd.packet_id = ap.packet_id) AS document_count
     FROM appeal_packet ap
     JOIN recovery_case rc ON rc.case_id = ap.case_id
     JOIN claim cl         ON cl.claim_id = rc.claim_id
     JOIN encounter e      ON e.encounter_id = cl.encounter_id
     JOIN patient pat      ON pat.patient_id = e.patient_id
     JOIN payer py         ON py.payer_id = cl.payer_id
     WHERE ${where.join(' AND ')}
     ORDER BY ap.created_at DESC`,
    params,
  );
  return rows.rows;
}
