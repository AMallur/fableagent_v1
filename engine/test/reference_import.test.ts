import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanonicalReferenceCsv } from '../src/reference/canonical.ts';

describe('canonical external reference formats', () => {
  it('parses CMS PFS facility and nonfacility rates without guessing columns', () => {
    const out = parseCanonicalReferenceCsv('medicare_pfs', [
      'procedure_code,modifier,locality,effective_year,nonfacility_rate,facility_rate',
      '99213,,99,2026,93.21,67.14',
      'G2211,25,99,2026,17.01,17.01',
    ].join('\n'));
    assert.equal(out.errors.length, 0);
    assert.deepEqual(out.rows[0], {
      procedureCode: '99213', modifier: null, locality: '99', effectiveYear: 2026,
      nonfacilityRate: 93.21, facilityRate: 67.14,
    });
  });

  it('parses dated CARC/RARC records and preserves descriptions', () => {
    const out = parseCanonicalReferenceCsv('carc', [
      'code,description,start_date,last_modified,stop_date,status',
      '45,"Charge exceeds fee schedule, maximum allowable or contracted fee",2007-01-01,2025-01-01,,active',
    ].join('\n'));
    assert.equal(out.errors.length, 0);
    assert.match(out.rows[0].description, /contracted fee/);
  });

  it('validates NCCI modifier indicators and date order', () => {
    const good = parseCanonicalReferenceCsv('ncci_ptp', [
      'column_one_code,column_two_code,effective_date,deletion_date,modifier_indicator',
      '29881,29880,2026-01-01,,1',
    ].join('\n'));
    assert.equal(good.errors.length, 0);
    const bad = parseCanonicalReferenceCsv('ncci_ptp', [
      'column_one_code,column_two_code,effective_date,deletion_date,modifier_indicator',
      '29881,29880,2026-01-01,2025-01-01,4',
    ].join('\n'));
    assert.ok(bad.errors.some((e) => /0, 1, or 9/.test(e)));
    assert.ok(bad.errors.some((e) => /precedes/.test(e)));
  });

  it('rejects header drift rather than mapping a vendor export heuristically', () => {
    const out = parseCanonicalReferenceCsv('medicare_pfs', 'HCPCS,Price\n99213,10');
    assert.match(out.errors.join(' '), /header mismatch/);
    assert.equal(out.rows.length, 0);
  });
});
