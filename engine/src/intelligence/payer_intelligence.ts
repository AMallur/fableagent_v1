// ============================================================================
// PAYER-OUTCOME INTELLIGENCE (the flywheel's query + decision layer)
//
// Reads the tenant's own RECORDED appeal outcomes (appeal_packet.outcome, set
// by manualMatch and the outcome-recording flow from migration 0029) and turns
// them, through statistics.ts, into two things:
//
//   * loadPayerIntelligence(db, {tenantId, clientIds?}) -> an IntelligenceIndex
//     computed ONCE. It aggregates every resolved appeal grouped by
//     (payer, argument category, appeal level, submission channel), derives a
//     global and per-payer base rate to shrink thin cells toward, and hands
//     back an .assess() accessor. Generation calls this once per run (like the
//     category_history CTE in context.ts) and then looks up each case in O(1),
//     rather than issuing an aggregate query per case.
//
//   * report(index) -> a payer-by-payer view for the ops UI: per-category win
//     rates with confidence, sample size, expected recovery, and the
//     best-performing submission channel per payer.
//
// SCOPE: tenant-only. Every row read is the tenant's own, under the tenant's
// RLS context, and the explicit tenant_id predicate is belt-and-suspenders on
// top of that. No cross-tenant pooling -- see migration 0030's header for why
// that is a contractual decision deferred out of this layer.
// ============================================================================

import type { UUID } from '../types.ts';
import type { Queryable } from '../db/snapshot.ts';
import type { LetterCategory, AppealType, SubmissionMethod } from '../appeals/types.ts';
import {
  estimate, rankOptions, type OutcomeEstimate, type OutcomeTally, type EstimateOptions,
} from './statistics.ts';

/** When a cell's confidence-adjusted win rate is at or below this and it is not
 *  cold-start, the argument is one this payer reliably rejects at this level:
 *  worth a human's eyes before it goes out, and never auto-submitted. */
export const REVIEW_WIN_RATE_FLOOR = 0.35;

const OUTCOME_VALUES = ['overturned', 'upheld', 'partial'] as const;

interface RawRow {
  payer_id: UUID;
  payer_name: string;
  category: LetterCategory;
  appeal_type: AppealType;
  submission_method: SubmissionMethod | null;
  outcome: 'overturned' | 'upheld' | 'partial';
  n: number;
  recovered: number;
  disputed: number;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

function emptyTally(): OutcomeTally & { recoveredAmount: number; disputedAmount: number } {
  return { overturned: 0, partial: 0, upheld: 0, recoveredAmount: 0, disputedAmount: 0 };
}

function addRow(t: ReturnType<typeof emptyTally>, r: RawRow): void {
  if (r.outcome === 'overturned') t.overturned += r.n;
  else if (r.outcome === 'partial') t.partial += r.n;
  else t.upheld += r.n;
  t.recoveredAmount += num(r.recovered);
  t.disputedAmount += num(r.disputed);
}

function successes(t: OutcomeTally): number { return t.overturned + t.partial; }
function resolvedOf(t: OutcomeTally): number { return t.overturned + t.partial + t.upheld; }

// ---------------------------------------------------------------------------
// the recommendation returned to generation
// ---------------------------------------------------------------------------

export interface ArgumentAssessment {
  payerId: UUID;
  category: LetterCategory;
  appealType: AppealType;
  estimate: OutcomeEstimate;
  /** true when this payer reliably rejects this argument at this level and the
   *  sample is real enough to trust — caller should force human review. */
  flagForReview: boolean;
  /** one-line, human-readable rationale suitable for a review note / audit. */
  note: string;
  /** compact object frozen onto appeal_packet.intelligence at generation. */
  snapshot: IntelligenceSnapshot;
}

export interface IntelligenceSnapshot {
  payerId: UUID;
  category: LetterCategory;
  appealType: AppealType;
  resolved: number;
  overturned: number;
  partial: number;
  upheld: number;
  winRate: number;             // naive point rate
  adjustedWinRate: number;     // confidence-adjusted (Wilson lower bound)
  expectedRecoveryPerAttempt: number | null;
  confidence: string;          // label
  coldStart: boolean;
  baseRate: number;            // prior the estimate was shrunk toward
  flaggedForReview: boolean;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// the index
// ---------------------------------------------------------------------------

const cellKey = (payerId: string, c: string, a: string) => `${payerId}|${c}|${a}`;

export class IntelligenceIndex {
  private readonly cells: Map<string, ReturnType<typeof emptyTally>>;
  private readonly payerTally: Map<string, ReturnType<typeof emptyTally>>;
  private readonly payerName: Map<string, string>;
  private readonly channelByPayer: Map<string, Map<SubmissionMethod, ReturnType<typeof emptyTally>>>;
  private readonly global: ReturnType<typeof emptyTally>;
  private readonly options: Required<Pick<EstimateOptions, 'priorStrength' | 'z' | 'minSample'>>;

  constructor(rows: RawRow[], options: EstimateOptions = {}) {
    this.cells = new Map();
    this.payerTally = new Map();
    this.payerName = new Map();
    this.channelByPayer = new Map();
    this.global = emptyTally();
    this.options = {
      priorStrength: options.priorStrength ?? 5,
      z: options.z ?? 1.96,
      minSample: options.minSample ?? 8,
    };

    for (const r of rows) {
      this.payerName.set(r.payer_id, r.payer_name);

      const ck = cellKey(r.payer_id, r.category, r.appeal_type);
      const cell = this.cells.get(ck) ?? emptyTally();
      addRow(cell, r);
      this.cells.set(ck, cell);

      const pt = this.payerTally.get(r.payer_id) ?? emptyTally();
      addRow(pt, r);
      this.payerTally.set(r.payer_id, pt);

      if (r.submission_method) {
        let byChan = this.channelByPayer.get(r.payer_id);
        if (!byChan) { byChan = new Map(); this.channelByPayer.set(r.payer_id, byChan); }
        const chan = byChan.get(r.submission_method) ?? emptyTally();
        addRow(chan, r);
        byChan.set(r.submission_method, chan);
      }

      addRow(this.global, r);
    }
  }

  /** global success rate across the whole tenant, or 0.5 with no data. */
  globalBaseRate(): number {
    const n = resolvedOf(this.global);
    return n > 0 ? successes(this.global) / n : 0.5;
  }

  /** the prior a given payer's cells shrink toward: the payer's own overall
   *  rate once it has a real sample, else the global rate, else 0.5. */
  private baseRateFor(payerId: string): number {
    const pt = this.payerTally.get(payerId);
    if (pt && resolvedOf(pt) >= this.options.minSample) {
      return successes(pt) / resolvedOf(pt);
    }
    return this.globalBaseRate();
  }

  private estimateCell(payerId: string, category: string, appealType: string): OutcomeEstimate {
    const tally = this.cells.get(cellKey(payerId, category, appealType)) ?? emptyTally();
    return estimate(tally, { ...this.options, baseRate: this.baseRateFor(payerId) });
  }

  /**
   * Generation-time read for one case. Never changes the legal argument (that
   * is fixed by the denial), only reports how this payer has historically
   * answered it and whether that history warrants forcing human review.
   */
  assess(payerId: UUID, category: LetterCategory, appealType: AppealType): ArgumentAssessment {
    const est = this.estimateCell(payerId, category, appealType);
    const baseRate = this.baseRateFor(payerId);
    const flagForReview = !est.coldStart && est.adjustedWinRate <= REVIEW_WIN_RATE_FLOOR;

    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const note = est.coldStart
      ? `Payer intelligence: only ${est.resolved} resolved ${category} appeal(s) on record for this payer at ${appealType.replace('_', ' ')}. Not enough history yet, proceeding on the standard playbook.`
      : `Payer intelligence: this payer has recovered on ${pct(est.pointWinRate)} of ${est.resolved} resolved ${category} appeals at ${appealType.replace('_', ' ')} (confidence-adjusted ${pct(est.adjustedWinRate)}, ${est.label} confidence).`
        + (flagForReview
          ? ` This payer reliably rejects this argument at this level; flag for senior review or consider escalation before sending.`
          : '');

    return {
      payerId, category, appealType, estimate: est, flagForReview, note,
      snapshot: {
        payerId, category, appealType,
        resolved: est.resolved, overturned: est.overturned,
        partial: est.partial, upheld: est.upheld,
        winRate: est.pointWinRate, adjustedWinRate: est.adjustedWinRate,
        expectedRecoveryPerAttempt: est.expectedRecoveryPerAttempt,
        confidence: est.label, coldStart: est.coldStart,
        baseRate: Math.round(baseRate * 10000) / 10000,
        flaggedForReview: flagForReview,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /** the best-performing submission channel for a payer (ranked, cold-start
   *  last), or null when the payer has no channel history. */
  bestChannel(payerId: UUID): { method: SubmissionMethod; estimate: OutcomeEstimate } | null {
    const byChan = this.channelByPayer.get(payerId);
    if (!byChan || byChan.size === 0) return null;
    const ranked = rankOptions(
      [...byChan.entries()].map(([method, tally]) => ({
        key: method,
        estimate: estimate(tally, { ...this.options, baseRate: this.baseRateFor(payerId) }),
      })),
    );
    const top = ranked[0];
    return top ? { method: top.key, estimate: top.estimate } : null;
  }

  /** payer-by-payer report for the ops UI. */
  report(): PayerIntelligenceReport {
    const payers: PayerIntelligenceRow[] = [];
    for (const [payerId, pt] of this.payerTally) {
      const categories: CategoryIntelligence[] = [];
      for (const [key, tally] of this.cells) {
        if (!key.startsWith(`${payerId}|`)) continue;
        const [, category, appealType] = key.split('|');
        categories.push({
          category: category as LetterCategory,
          appealType: appealType as AppealType,
          estimate: estimate(tally, { ...this.options, baseRate: this.baseRateFor(payerId) }),
        });
      }
      categories.sort((a, b) => b.estimate.adjustedWinRate - a.estimate.adjustedWinRate);
      const chan = this.bestChannel(payerId);
      payers.push({
        payerId,
        payerName: this.payerName.get(payerId) ?? 'Unknown payer',
        resolvedAppeals: resolvedOf(pt),
        overallWinRate: resolvedOf(pt) > 0
          ? Math.round((successes(pt) / resolvedOf(pt)) * 10000) / 10000 : 0,
        totalRecovered: Math.round(pt.recoveredAmount * 100) / 100,
        bestChannel: chan ? { method: chan.method, adjustedWinRate: chan.estimate.adjustedWinRate } : null,
        categories,
      });
    }
    payers.sort((a, b) => b.resolvedAppeals - a.resolvedAppeals);
    return { payers, globalBaseRate: Math.round(this.globalBaseRate() * 10000) / 10000 };
  }
}

export interface CategoryIntelligence {
  category: LetterCategory;
  appealType: AppealType;
  estimate: OutcomeEstimate;
}
export interface PayerIntelligenceRow {
  payerId: UUID;
  payerName: string;
  resolvedAppeals: number;
  overallWinRate: number;
  totalRecovered: number;
  bestChannel: { method: SubmissionMethod; adjustedWinRate: number } | null;
  categories: CategoryIntelligence[];
}
export interface PayerIntelligenceReport {
  payers: PayerIntelligenceRow[];
  globalBaseRate: number;
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

export interface IntelligenceScope {
  tenantId: UUID;
  /** optional client filter for the ops report; omit for the tenant-wide model
   *  generation uses (the flywheel learns from the whole tenant). */
  clientIds?: UUID[];
  options?: EstimateOptions;
}

export async function loadPayerIntelligence(
  db: Queryable, scope: IntelligenceScope,
): Promise<IntelligenceIndex> {
  const params: unknown[] = [scope.tenantId, OUTCOME_VALUES as unknown as string[]];
  let clientFilter = '';
  if (scope.clientIds?.length) {
    params.push(scope.clientIds);
    clientFilter = ` AND cl.client_id = ANY($${params.length})`;
  }

  const rows = await db.query(
    `SELECT cl.payer_id, py.payer_name,
            ap.letter_category AS category,
            ap.appeal_type,
            ap.submission_method,
            ap.outcome,
            count(*)::int AS n,
            COALESCE(sum(ap.outcome_amount), 0) AS recovered,
            COALESCE(sum(rc.recovery_opportunity), 0) AS disputed
     FROM appeal_packet ap
     JOIN recovery_case rc ON rc.case_id = ap.case_id AND rc.tenant_id = ap.tenant_id
     JOIN claim cl ON cl.claim_id = rc.claim_id
     JOIN payer py ON py.payer_id = cl.payer_id
     WHERE ap.tenant_id = $1
       AND ap.deleted_at IS NULL
       AND ap.outcome = ANY($2)
       AND ap.letter_category IS NOT NULL${clientFilter}
     GROUP BY cl.payer_id, py.payer_name, ap.letter_category,
              ap.appeal_type, ap.submission_method, ap.outcome`,
    params,
  );

  return new IntelligenceIndex(rows.rows as RawRow[], scope.options);
}

/** Convenience for the ops report path (Scope with clientIds). */
export async function payerOutcomeIntelligence(
  db: Queryable, scope: { tenantId: UUID; clientIds: UUID[] },
): Promise<PayerIntelligenceReport> {
  const index = await loadPayerIntelligence(db, {
    tenantId: scope.tenantId, clientIds: scope.clientIds,
  });
  return index.report();
}
