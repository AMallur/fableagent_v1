import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidPayerStatusTransition,
  evaluatePayerReadiness,
  type PayerReadinessFacts,
} from '../src/integration/readiness.ts';

const readyFacts = (overrides: Partial<PayerReadinessFacts> = {}): PayerReadinessFacts => ({
  requireActivation: true,
  configExists: true,
  status: 'active',
  detectionEnabled: true,
  appealsEnabled: true,
  electronicSubmissionEnabled: true,
  payerMappingValidated: true,
  edi835Validated: true,
  edi837pValidated: true,
  contractPricingValidated: true,
  appealRulesValidated: true,
  submissionRouteValidated: true,
  referenceDataValidated: true,
  hasActiveContract: true,
  pricingMode: 'contract',
  ...overrides,
});

test('legacy clients preserve existing processing behavior', () => {
  const out = evaluatePayerReadiness(readyFacts({
    requireActivation: false,
    configExists: false,
    status: null,
    electronicSubmissionEnabled: false,
  }));
  assert.equal(out.state, 'legacy_bypass');
  assert.equal(out.detection.enabled, true);
  assert.equal(out.appeals.enabled, true);
  assert.equal(out.electronicSubmission.enabled, false);
});

test('new client/payer configurations fail closed while draft', () => {
  const out = evaluatePayerReadiness(readyFacts({
    status: 'draft',
    detectionEnabled: false,
    appealsEnabled: false,
    electronicSubmissionEnabled: false,
    payerMappingValidated: false,
    edi835Validated: false,
    contractPricingValidated: false,
    appealRulesValidated: false,
    submissionRouteValidated: false,
    referenceDataValidated: false,
    hasActiveContract: false,
  }));
  assert.equal(out.state, 'draft');
  assert.equal(out.productionReady, false);
  assert.ok(out.detection.blockers.some((v) => v.includes('not active')));
  assert.ok(out.detection.blockers.some((v) => v.includes('835')));
});

test('fully validated active payer enables all capabilities', () => {
  const out = evaluatePayerReadiness(readyFacts());
  assert.equal(out.state, 'ready');
  assert.equal(out.productionReady, true);
  assert.equal(out.detection.enabled, true);
  assert.equal(out.appeals.enabled, true);
  assert.equal(out.electronicSubmission.enabled, true);
  assert.deepEqual(out.electronicSubmission.blockers, []);
});

test('electronic submission remains independently gated', () => {
  const out = evaluatePayerReadiness(readyFacts({
    electronicSubmissionEnabled: false,
    submissionRouteValidated: false,
  }));
  assert.equal(out.detection.enabled, true);
  assert.equal(out.appeals.enabled, true);
  assert.equal(out.electronicSubmission.enabled, false);
  assert.ok(out.electronicSubmission.blockers.includes('electronic submission is disabled'));
});

test('manual pricing never silently becomes autonomous pricing', () => {
  const out = evaluatePayerReadiness(readyFacts({ pricingMode: 'manual' }));
  assert.equal(out.detection.enabled, true);
  assert.ok(out.detection.warnings.some((v) => v.includes('shadow-only')));
});

test('status lifecycle prevents unsafe jumps', () => {
  assert.doesNotThrow(() => assertValidPayerStatusTransition('draft', 'validation_pending'));
  assert.doesNotThrow(() => assertValidPayerStatusTransition('validated', 'active'));
  assert.throws(
    () => assertValidPayerStatusTransition('draft', 'active'),
    /invalid client\/payer status transition/,
  );
  assert.throws(
    () => assertValidPayerStatusTransition('retired', 'active'),
    /invalid client\/payer status transition/,
  );
});
