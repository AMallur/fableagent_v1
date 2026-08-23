import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  runCmsPublicPoc,
  type CmsPublicPocFixture,
} from '../src/pilot/cms_public_poc.ts';

describe('CMS public-data anchored proof of concept', () => {
  it('detects controlled payment perturbations without flagging controls', async () => {
    const url = new URL('../testdata/cms_2024_public_poc_fixture.json', import.meta.url);
    const fixture = JSON.parse(await readFile(url, 'utf8')) as CmsPublicPocFixture;
    const result = runCmsPublicPoc(fixture);
    const { metrics, findings } = result;

    assert.equal(metrics.sourceProviderCount, 9);
    assert.equal(metrics.sourceServiceRows, 47);
    assert.equal(metrics.representedServiceCount, 4554);
    assert.equal(metrics.representedBeneficiaryCount, 2781);
    assert.equal(metrics.engineScenarioLines, 94);
    assert.equal(metrics.controls, 47);
    assert.equal(metrics.perturbed, 47);

    assert.equal(metrics.truePositives, 47);
    assert.equal(metrics.falsePositives, 0);
    assert.equal(metrics.falseNegatives, 0);
    assert.equal(metrics.trueNegatives, 47);
    assert.equal(metrics.precision, 1);
    assert.equal(metrics.recall, 1);
    assert.equal(metrics.specificity, 1);

    assert.equal(metrics.injectedUnderpaymentDollars, 1201.15);
    assert.equal(metrics.detectedOpportunityDollars, 1201.15);
    assert.equal(metrics.dollarDetectionAbsoluteError, 0);
    assert.equal(metrics.productionThresholdDollars, 25);
    assert.equal(metrics.casesCreated, 21);
    assert.equal(metrics.expectedCasesAtThreshold, 21);
    assert.equal(metrics.belowThresholdDetections, 26);
    assert.equal(metrics.caseOpportunityDollars, 876.55);
    assert.equal(metrics.belowThresholdOpportunityDollars, 324.6);

    const controls = findings.filter((finding) => finding.scenario === 'control');
    const perturbed = findings.filter((finding) => finding.scenario === 'perturbed');
    assert.ok(controls.every((finding) => !finding.detected && finding.caseDisposition === 'none'));
    assert.ok(perturbed.every((finding) => finding.detected));
    assert.ok(perturbed.every((finding) =>
      finding.injectedUnderpayment >= 25
        ? finding.caseDisposition === 'created'
        : finding.caseDisposition === 'below_threshold'));
  });
});
