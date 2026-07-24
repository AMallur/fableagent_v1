// ============================================================================
// The callable detection service.
//
//   runDetectionJob(pool, { tenantId, clientId?, asOf?, dryRun? })
//
// Lifecycle:
//   1. insert a system_job row (run_detection, running)
//   2. snapshot the tenant/client data
//   3. runEngine (pure)
//   4. persist the result in a single transaction (skipped when dryRun)
//   5. mark the job completed with stats + JSON summary in log_output
// On any error the job row is marked failed with the error in log_output.
//
// Trigger it from a scheduler (cron/queue worker) or manually via cli.ts.
// Alert notifications surface in result.summary.alerts and are recorded on
// the job row; actual delivery belongs to the send_alerts job type.
// ============================================================================

import type { EngineConfig, EngineResult, UUID } from './types.ts';
import { runEngine } from './engine.ts';
import { loadSnapshot, type Queryable } from './db/snapshot.ts';
import { persistResult, type PersistStats } from './db/persist.ts';

/** pg.Pool satisfies this. */
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export interface DetectionJobParams {
  tenantId: UUID;
  clientId?: UUID;
  asOf?: string;
  configOverrides?: Partial<EngineConfig>;
  /** run the engine and report, but write nothing */
  dryRun?: boolean;
}

export interface DetectionJobResult {
  jobId: UUID | null;
  dryRun: boolean;
  result: EngineResult;
  persisted: PersistStats | null;
}

export async function runDetectionJob(
  pool: PoolLike, params: DetectionJobParams,
): Promise<DetectionJobResult> {
  const { tenantId } = params;

  // One connection for the whole job, tenant context set once: every table
  // touched below (system_job, plus whatever loadSnapshot/persistResult
  // read/write) carries RLS scoped to app.current_tenant_id(), and a bare
  // pool.query() call would grab a random pool connection with no tenant
  // context set at all — RLS would then hide/reject rows even though the
  // query's own explicit WHERE clauses are correct.
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);

    let jobId: UUID | null = null;
    if (!params.dryRun) {
      const job = await client.query(
        `INSERT INTO system_job (tenant_id, client_id, job_type, status, started_at)
         VALUES ($1, $2, 'run_detection', 'running', now())
         RETURNING job_id`,
        [tenantId, params.clientId ?? null],
      );
      jobId = job.rows[0].job_id;
    }

    try {
      const input = await loadSnapshot(client, {
        tenantId,
        clientId: params.clientId,
        asOf: params.asOf,
        configOverrides: params.configOverrides,
      });

      const result = runEngine(input);

      let persisted: PersistStats | null = null;
      if (!params.dryRun) {
        try {
          await client.query('BEGIN');
          persisted = await persistResult(client, tenantId, result, jobId);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }

        await client.query(
          `UPDATE system_job
           SET status = 'completed', completed_at = now(),
               records_processed = $1, errors_count = $2, log_output = $3
           WHERE job_id = $4`,
          [result.summary.remitLinesProcessed,
           result.summary.unmatched,
           JSON.stringify(result.summary),
           jobId],
        );
      }

      return { jobId, dryRun: !!params.dryRun, result, persisted };
    } catch (err) {
      if (jobId) {
        await client.query(
          `UPDATE system_job
           SET status = 'failed', completed_at = now(), errors_count = 1, log_output = $1
           WHERE job_id = $2`,
          [String(err instanceof Error ? err.stack ?? err.message : err), jobId],
        ).catch(() => { /* job bookkeeping must not mask the real error */ });
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
