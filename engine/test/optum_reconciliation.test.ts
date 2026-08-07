import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileChangeHealthcareDelivery } from '../src/integration/optum_reconciliation.ts';
import { __resetOptumTokenCacheForTests } from '../src/integration/optum_client.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** minimal fake pool: one outbound_delivery row, records the UPDATE call */
function fakePool(deliveryRow: Record<string, unknown> | null) {
  const updates: Array<{ text: string; params: unknown[] }> = [];
  return {
    updates,
    async query(text: string, params: unknown[] = []) {
      if (text.startsWith('SELECT')) return { rows: deliveryRow ? [deliveryRow] : [] };
      updates.push({ text, params });
      return { rows: [] };
    },
  };
}

describe('reconcileChangeHealthcareDelivery', () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.OPTUM_CLIENT_ID = 'id';
    process.env.OPTUM_CLIENT_SECRET = 'secret';
    __resetOptumTokenCacheForTests();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    globalThis.fetch = savedFetch;
    __resetOptumTokenCacheForTests();
  });

  it('returns null for a delivery that is not ours or never reached sent', async () => {
    const pool = fakePool({ delivery_id: 'd1', connector: 'waystar', status: 'sent', detail: {} });
    const r1 = await reconcileChangeHealthcareDelivery(pool as any, { tenantId: 't', deliveryId: 'd1' });
    assert.equal(r1, null);

    const pool2 = fakePool({ delivery_id: 'd2', connector: 'change_healthcare', status: 'not_configured', detail: {} });
    const r2 = await reconcileChangeHealthcareDelivery(pool2 as any, { tenantId: 't', deliveryId: 'd2' });
    assert.equal(r2, null);
  });

  it('skips when the delivery has no stored claimRequest to reconcile against', async () => {
    const pool = fakePool({
      delivery_id: 'd3', connector: 'change_healthcare', status: 'sent',
      detail: { payload: { type: 'appeal_packet' } },
    });
    const result = await reconcileChangeHealthcareDelivery(pool as any, { tenantId: 't', deliveryId: 'd3' });
    assert.equal(result?.outcome, 'skipped');
  });

  it('checks claim status via the confirmed endpoint and records the raw result', async () => {
    let calledPath: string | undefined;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/token')) return jsonResponse(200, { access_token: 'tok', expires_in: 3600 });
      calledPath = String(url);
      return jsonResponse(200, {
        claims: [{ claimStatus: { statusCategoryCode: 'F0', statusCode: '1' } }],
        meta: { traceId: 'abc' },
      });
    }) as typeof fetch;

    const claimRequest = {
      controlNumber: '000000001',
      tradingPartnerServiceId: '9496',
      billing: { npi: '1760854442' },
      subscriber: { memberId: 'MEM0001', firstName: 'Jane', lastName: 'Doe', dateOfBirth: '19800102' },
      claimInformation: { serviceLines: [{ serviceDate: '20260115' }] },
    };
    const pool = fakePool({
      delivery_id: 'd4', connector: 'change_healthcare', status: 'sent',
      detail: { payload: { claimRequest }, reference: 'ref-123' },
    });

    const result = await reconcileChangeHealthcareDelivery(pool as any, { tenantId: 't', deliveryId: 'd4' });
    assert.equal(result?.outcome, 'checked');
    assert.ok(calledPath?.includes('/medicalnetwork/claimstatus/v2/'));
    assert.equal(pool.updates.length, 1);
    assert.match(pool.updates[0].text, /jsonb_set\(detail, '\{reconciliation\}'/);
  });
});
