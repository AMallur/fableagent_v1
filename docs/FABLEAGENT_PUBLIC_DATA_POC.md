# FableAgent Public-Data Proof of Concept

**Evidence class:** public-data-anchored controlled perturbation test  
**Repository:** `AMallur/fableagent_v1`  
**Merged POC commit:** `7f4f89670e9aa9393c2dbfd5576855e6a697387e`

## What FableAgent does

FableAgent is a healthcare revenue-cycle underpayment and denial-detection engine. Its core workflow matches submitted professional claims to remittances, applies contract or Medicare-reference pricing, calculates expected payer responsibility after patient liability, identifies reimbursement variance, scores recovery opportunities, and creates cases for human review.

## Public-data test design

The proof of concept used **47 real CMS 2024 Medicare Physician & Other Practitioners provider-service observations across 9 public NPIs** as the reimbursement-economic anchor.

Each observation was converted into two deterministic engine scenarios:

1. **Control:** the published CMS reimbursement economics were preserved.
2. **Perturbed:** a copied payer payment was reduced by a preregistered 25%, 35%, 50%, or 65% amount to create known ground truth.

This produced **94 total claim/remittance scenarios**: 47 controls and 47 controlled payment-variance scenarios.

The controlled reductions are synthetic test perturbations. They are **not** represented as historical CMS underpayments.

FableAgent then ran its normal production path:

`payer-claim matching → fee-schedule pricing → patient-responsibility normalization → expected payer amount → variance detection → scoring → $25 case threshold`

No POC-only detector was substituted for the normal engine.

## Results

| Measure | Result |
|---|---:|
| Real CMS provider-service source observations | 47 |
| Source NPIs | 9 |
| Total engine scenarios | 94 |
| Unchanged controls | 47 |
| Controlled payment-variance scenarios | 47 |
| True positives | 47 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 47 |
| Precision in this controlled test | 100% |
| Recall in this controlled test | 100% |
| Specificity in this controlled test | 100% |
| Injected variance dollars | $1,201.15 |
| Engine-quantified opportunity | $1,201.15 |
| Absolute dollar error | $0.00 |
| Cases created at $25 threshold | 21 |
| Detected opportunities below $25 threshold | 26 |

The POC runner is fail-closed: CI fails if an unchanged control is falsely flagged, a controlled variance is missed, quantified opportunity dollars fail to reconcile, or production-threshold case behavior differs from the preregistered expectation.

## What this demonstrates

- The production engine can process reimbursement economics grounded in real CMS public data.
- Matching, expected-reimbursement calculation, patient-responsibility handling, variance detection, thresholding, and case creation work together reproducibly.
- Known payment shortfalls are detected and quantified correctly in this controlled test.
- Unchanged controls remain unflagged in this controlled test.
- The result is reproducible from versioned test data, finding-level output, engine commit, CI execution, and SHA-256 evidence manifests.

## What this does **not** demonstrate

This test does **not** claim:

- that CMS actually underpaid any of the sampled services;
- 100% accuracy on real historical payer claims;
- raw production 837P/835 validation on these CMS rows;
- customer validation;
- independent RCM adjudication;
- recovered cash;
- payer certification; or
- compliance certification.

## Next validation step

The next study is a bounded retrospective validation using a provider or RCM organization's historical:

- 837P professional claims;
- corresponding 835 remittances;
- applicable payer contracts / fee schedules;
- previously worked underpayment or recovery history where available; and
- independent revenue-cycle reviewer dispositions.

The preferred design is shadow-mode only: no autonomous payer submission, a frozen denominator, blinded engine output, and independent human adjudication of every finding.

## Reproducibility

The public-data POC harness, tests, fixture, CI steps, evidence-manifest tooling, and claim-boundary documentation are included in the repository. The POC was introduced and verified through PR #22.

**PR #22:** https://github.com/AMallur/fableagent_v1/pull/22

**Repository:** https://github.com/AMallur/fableagent_v1
