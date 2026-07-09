// Fixture builders: a minimal but complete EngineInput, overridable per test.

import type {
  ClaimInput, ClaimLineInput, EngineInput, RemitLineInput,
} from '../src/types.ts';
import { makeConfig } from '../src/config.ts';

export const TENANT = 'tenant-1';
export const CLIENT = 'client-1';
export const PAYER = 'payer-1';
export const PATIENT = 'patient-1';

export const AS_OF = '2026-07-01';

let seq = 0;
export const id = (prefix: string) => `${prefix}-${++seq}`;

export function claimLine(overrides: Partial<ClaimLineInput> = {}): ClaimLineInput {
  return {
    claimLineId: id('line'),
    lineNumber: 1,
    procedureCode: '99213',
    modifiers: [],
    units: 1,
    billedAmount: 250,
    ...overrides,
  };
}

export function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    claimId: id('claim'),
    clientId: CLIENT,
    payerId: PAYER,
    patientId: PATIENT,
    claimNumberInternal: id('CLM'),
    claimNumberPayer: null,
    dateOfServiceStart: '2026-06-01',
    submissionDate: '2026-06-05',
    claimStatus: 'submitted',
    authorizationNumber: null,
    availableDocumentTypes: [],
    lines: [claimLine()],
    ...overrides,
  };
}

export function remitLine(overrides: Partial<RemitLineInput> = {}): RemitLineInput {
  return {
    remittanceLineId: id('remit'),
    remittanceId: 'remittance-1',
    payerId: PAYER,
    checkDate: '2026-06-25',
    procedureCode: '99213',
    billedAmount: 250,
    paidAmount: 100,
    ...overrides,
  };
}

export function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    tenantId: TENANT,
    config: makeConfig(AS_OF),
    payers: [{
      payerId: PAYER, payerName: 'Test Payer',
      appealDeadlineDays: 180, timelyFilingLimitDays: 90,
    }],
    patients: [{
      patientId: PATIENT, insuranceIdPrimary: 'MEM123', insuranceIdSecondary: null,
    }],
    claims: [],
    remitLines: [],
    contracts: [],
    medicareRates: {},
    existingCases: [],
    winRates: [],
    clientPayerConfigs: [],
    clientAlertThresholds: {},
    ...overrides,
  };
}

/** One matched claim/remit pair with a fee-schedule contract rate. */
export function matchedScenario(opts: {
  contractRate?: number;
  paid?: number;
  carc?: string | null;
  group?: string | null;
  authNumber?: string | null;
  docs?: string[];
} = {}): EngineInput {
  const line = claimLine({ billedAmount: 250 });
  const c = claim({
    claimNumberPayer: 'ICN-1',
    lines: [line],
    authorizationNumber: opts.authNumber ?? null,
    availableDocumentTypes: opts.docs ?? [],
  });
  const r = remitLine({
    payerClaimNumber: 'ICN-1',
    paidAmount: opts.paid ?? 100,
    adjustmentReasonCode: opts.carc ?? null,
    adjustmentGroupCode: opts.group ?? null,
  });
  return baseInput({
    claims: [c],
    remitLines: [r],
    contracts: opts.contractRate == null ? [] : [{
      contractId: id('contract'),
      clientId: CLIENT,
      payerId: PAYER,
      effectiveDate: '2026-01-01',
      expirationDate: null,
      feeScheduleType: 'fee_schedule',
      lines: [{ procedureCode: '99213', modifier: null, allowedAmount: opts.contractRate }],
    }],
  });
}
