// ============================================================================
// Outbound connectors (Phase-2 hooks, built as abstractions now).
//
// Three connector kinds:
//   clearinghouse  — appeal / corrected-claim submission (Waystar, Availity,
//                    Change Healthcare)
//   payer_portal   — direct portal submission (configurable per payer)
//   pm_writeback   — case status write-back to the PM/EHR
//
// A connector implements OutboundConnector; the registry resolves by name.
// The shipped connectors are recording stubs: every dispatch writes an
// outbound_delivery row (status 'not_configured') and a case_action note, so
// the full submission trail exists today and a real integration only has to
// implement send() — nothing upstream restructures.
// ============================================================================

import type { UUID } from '../types.ts';
import type { PoolLike } from '../service.ts';
import type { Queryable } from '../db/snapshot.ts';
import { loadOptumConfig, submitProfessionalClaim } from './optum_client.ts';

export interface ConnectorContext {
  tenantId: UUID;
  clientId: UUID;
  caseId: UUID | null;
  packetId: UUID | null;
  /** connector-specific configuration from client_integration / payer */
  config: Record<string, unknown>;
}

export interface ConnectorResult {
  status: 'sent' | 'failed' | 'not_configured';
  reference?: string;          // payer/clearinghouse tracking id
  detail?: Record<string, unknown>;
}

export interface OutboundConnector {
  readonly name: string;
  readonly kind: 'clearinghouse' | 'payer_portal' | 'pm_writeback';
  send(ctx: ConnectorContext, payload: Record<string, unknown>): Promise<ConnectorResult>;
}

/** recording stub — the integration point exists; the wire protocol doesn't yet */
class StubConnector implements OutboundConnector {
  readonly name: string;
  readonly kind: OutboundConnector['kind'];
  private readonly label: string;

  constructor(name: string, kind: OutboundConnector['kind'], label: string) {
    this.name = name;
    this.kind = kind;
    this.label = label;
  }

  async send(): Promise<ConnectorResult> {
    return {
      status: 'not_configured',
      detail: {
        message: `${this.label} connector is registered but no live credentials/protocol `
          + 'are configured — the submission is recorded and can be replayed once the '
          + 'integration goes live',
      },
    };
  }
}

/**
 * Real Optum / Change Healthcare connector: OAuth2 auth, bounded retry on
 * transient failures only, and a real payer-side tracking reference.
 *
 * Stays in 'not_configured' whenever OPTUM_CLIENT_ID/SECRET are unset (same
 * safe default as every other connector) AND whenever
 * OPTUM_ALLOW_LIVE_SUBMISSION is not '1' — matching the pilot go/no-go gate
 * in docs/PRODUCTION_READINESS.md, which requires manual submission until
 * this connector's idempotency/ack/retry/reconciliation behavior has been
 * certified in the target environment. Flipping that env var is a deploy-
 * time decision, not something this code should default to.
 */
class ChangeHealthcareConnector implements OutboundConnector {
  readonly name = 'change_healthcare';
  readonly kind = 'clearinghouse' as const;

  async send(_ctx: ConnectorContext, payload: Record<string, unknown>): Promise<ConnectorResult> {
    if (!loadOptumConfig()) {
      return {
        status: 'not_configured',
        detail: {
          message: 'Optum / Change Healthcare connector is registered but OPTUM_CLIENT_ID/'
            + 'OPTUM_CLIENT_SECRET are not set — the submission is recorded and can be '
            + 'replayed once credentials are configured',
        },
      };
    }
    if (process.env.OPTUM_ALLOW_LIVE_SUBMISSION !== '1') {
      return {
        status: 'not_configured',
        detail: {
          message: 'Optum credentials are configured but OPTUM_ALLOW_LIVE_SUBMISSION is not '
            + 'set to \'1\' — live clearinghouse submission stays disabled until the pilot '
            + 'go/no-go gate in docs/PRODUCTION_READINESS.md is met',
          credentialsConfigured: true,
        },
      };
    }

    const traceId = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined;
    try {
      const result = await submitProfessionalClaim(
        '/medicalnetwork/professionalclaims/v3/submission', payload, { traceId },
      );
      const body = result.body as { claimReference?: { correlationId?: string }; controlNumber?: string } | undefined;
      if (result.ok) {
        return {
          status: 'sent',
          reference: body?.claimReference?.correlationId ?? body?.controlNumber ?? traceId,
          detail: { attempts: result.attempts, response: result.body },
        };
      }
      return {
        status: 'failed',
        detail: { attempts: result.attempts, httpStatus: result.status, errors: result.body },
      };
    } catch (err) {
      // network/auth exhaustion after retries — transient, safe to replay later
      return {
        status: 'failed',
        detail: { message: err instanceof Error ? err.message : String(err), transient: true },
      };
    }
  }
}

const REGISTRY = new Map<string, OutboundConnector>();
export function registerConnector(connector: OutboundConnector): void {
  REGISTRY.set(connector.name, connector);
}
export function getConnector(name: string): OutboundConnector | undefined {
  return REGISTRY.get(name);
}
export function listConnectors(): Array<{ name: string; kind: string }> {
  return [...REGISTRY.values()].map((c) => ({ name: c.name, kind: c.kind }));
}

registerConnector(new StubConnector('waystar', 'clearinghouse', 'Waystar'));
registerConnector(new StubConnector('availity', 'clearinghouse', 'Availity'));
registerConnector(new ChangeHealthcareConnector());
registerConnector(new StubConnector('payer_portal', 'payer_portal', 'Payer portal'));
registerConnector(new StubConnector('pm_writeback', 'pm_writeback', 'PM/EHR write-back'));

const CLEARINGHOUSE_ALIASES: Record<string, string> = {
  waystar: 'waystar', availity: 'availity',
  change: 'change_healthcare', 'change healthcare': 'change_healthcare',
  changehealthcare: 'change_healthcare', optum: 'change_healthcare',
  'optum medical network': 'change_healthcare',
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function recordDelivery(
  pool: Queryable, ctx: ConnectorContext, connector: OutboundConnector,
  payload: Record<string, unknown>, result: ConnectorResult,
): Promise<UUID> {
  const attempts = typeof (result.detail as { attempts?: unknown } | undefined)?.attempts === 'number'
    ? (result.detail as { attempts: number }).attempts
    : 1;
  const inserted = await pool.query(
    `INSERT INTO outbound_delivery
       (tenant_id, client_id, case_id, packet_id, connector, kind, status, detail, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING delivery_id`,
    [ctx.tenantId, ctx.clientId, ctx.caseId, ctx.packetId, connector.name, connector.kind,
     result.status, JSON.stringify({ payload, result: result.detail ?? {}, reference: result.reference ?? null }),
     attempts]);
  if (ctx.caseId) {
    await pool.query(
      `INSERT INTO case_action (tenant_id, case_id, action_type, performed_by_system, notes)
       VALUES ($1, $2, 'note', true, $3)`,
      [ctx.tenantId, ctx.caseId,
       `Outbound ${connector.kind.replaceAll('_', ' ')} dispatch via ${connector.name}: ${result.status}`]);
  }
  return inserted.rows[0].delivery_id;
}

/** appeal packet -> clearinghouse or payer portal, chosen from client config */
export async function dispatchAppealSubmission(
  pool: PoolLike, args: { tenantId: UUID; packetId: UUID },
): Promise<{ deliveryId: UUID; connector: string; status: string } | null> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [args.tenantId]);
    // Serialize delivery of one packet across web replicas.
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [args.packetId]);
    const prior = await db.query(
      `SELECT delivery_id, connector, status FROM outbound_delivery
       WHERE packet_id = $1 AND tenant_id = $2 AND status = 'sent'
       ORDER BY created_at DESC LIMIT 1`, [args.packetId, args.tenantId]);
    if (prior.rows[0]) {
      await db.query('COMMIT');
      return {
        deliveryId: prior.rows[0].delivery_id,
        connector: prior.rows[0].connector,
        status: prior.rows[0].status,
      };
    }

    const rows = await db.query(
      `SELECT ap.packet_id, ap.case_id, ap.submission_method, rc.client_id,
              ci.clearinghouse_name, py.portal_url, py.payer_name,
              cl.claim_number_internal
       FROM appeal_packet ap
       JOIN recovery_case rc ON rc.case_id = ap.case_id
       JOIN claim cl ON cl.claim_id = rc.claim_id
       JOIN payer py ON py.payer_id = cl.payer_id
       LEFT JOIN client_integration ci ON ci.client_id = rc.client_id
       WHERE ap.packet_id = $1 AND ap.tenant_id = $2`,
      [args.packetId, args.tenantId]);
    const p = rows.rows[0];
    if (!p) {
      await db.query('COMMIT');
      return null;
    }

    let connectorName: string;
    if (p.submission_method === 'clearinghouse') {
      connectorName = CLEARINGHOUSE_ALIASES[String(p.clearinghouse_name ?? '').toLowerCase()]
        ?? 'change_healthcare';
    } else if (p.submission_method === 'portal') {
      connectorName = 'payer_portal';
    } else {
      await db.query('COMMIT');
      return null;   // mail/fax are human workflows, not connector dispatches
    }

    const connector = getConnector(connectorName)!;
    const ctx: ConnectorContext = {
      tenantId: args.tenantId, clientId: p.client_id,
      caseId: p.case_id, packetId: p.packet_id,
      config: { portalUrl: p.portal_url, clearinghouse: p.clearinghouse_name },
    };
    const payload = {
      type: 'appeal_packet', packetId: p.packet_id,
      idempotencyKey: `fableagent:appeal:${p.packet_id}`,
      claimNumber: p.claim_number_internal, payer: p.payer_name,
      method: p.submission_method,
    };
    const result = await connector.send(ctx, payload);
    const deliveryId = await recordDelivery(db, ctx, connector, payload, result);
    await db.query('COMMIT');
    return { deliveryId, connector: connector.name, status: result.status };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export class ConnectorUnavailableError extends Error {
  status = 409;
  constructor(connector: string) {
    super(`${connector} is not configured for live delivery; packet remains ready`);
    this.name = 'ConnectorUnavailableError';
  }
}

/** case status change -> PM/EHR write-back when the client has a PM configured */
export async function dispatchCaseWriteback(
  pool: PoolLike, args: { tenantId: UUID; caseId: UUID; status: string },
): Promise<{ deliveryId: UUID; status: string } | null> {
  const rows = await pool.query(
    `SELECT rc.client_id, ci.pm_system, cl.claim_number_internal
     FROM recovery_case rc
     JOIN claim cl ON cl.claim_id = rc.claim_id
     LEFT JOIN client_integration ci ON ci.client_id = rc.client_id
     WHERE rc.case_id = $1 AND rc.tenant_id = $2`,
    [args.caseId, args.tenantId]);
  const c = rows.rows[0];
  if (!c?.pm_system) return null;   // no PM configured -> nothing to write back

  const connector = getConnector('pm_writeback')!;
  const ctx: ConnectorContext = {
    tenantId: args.tenantId, clientId: c.client_id,
    caseId: args.caseId, packetId: null,
    config: { pmSystem: c.pm_system },
  };
  const payload = {
    type: 'case_status', caseId: args.caseId,
    claimNumber: c.claim_number_internal, status: args.status, pmSystem: c.pm_system,
  };
  const result = await connector.send(ctx, payload);
  const deliveryId = await recordDelivery(pool, ctx, connector, payload, result);
  return { deliveryId, status: result.status };
}
