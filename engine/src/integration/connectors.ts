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
registerConnector(new StubConnector('change_healthcare', 'clearinghouse', 'Change Healthcare'));
registerConnector(new StubConnector('payer_portal', 'payer_portal', 'Payer portal'));
registerConnector(new StubConnector('pm_writeback', 'pm_writeback', 'PM/EHR write-back'));

const CLEARINGHOUSE_ALIASES: Record<string, string> = {
  waystar: 'waystar', availity: 'availity',
  change: 'change_healthcare', 'change healthcare': 'change_healthcare',
  changehealthcare: 'change_healthcare',
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function recordDelivery(
  pool: PoolLike, ctx: ConnectorContext, connector: OutboundConnector,
  payload: Record<string, unknown>, result: ConnectorResult,
): Promise<UUID> {
  const inserted = await pool.query(
    `INSERT INTO outbound_delivery
       (tenant_id, client_id, case_id, packet_id, connector, kind, status, detail, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING delivery_id`,
    [ctx.tenantId, ctx.clientId, ctx.caseId, ctx.packetId, connector.name, connector.kind,
     result.status, JSON.stringify({ payload, result: result.detail ?? {}, reference: result.reference ?? null })]);
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
  const rows = await pool.query(
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
  if (!p) return null;

  let connectorName: string;
  if (p.submission_method === 'clearinghouse') {
    connectorName = CLEARINGHOUSE_ALIASES[String(p.clearinghouse_name ?? '').toLowerCase()]
      ?? 'change_healthcare';
  } else if (p.submission_method === 'portal') {
    connectorName = 'payer_portal';
  } else {
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
    claimNumber: p.claim_number_internal, payer: p.payer_name,
    method: p.submission_method,
  };
  const result = await connector.send(ctx, payload);
  const deliveryId = await recordDelivery(pool, ctx, connector, payload, result);
  return { deliveryId, connector: connector.name, status: result.status };
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
