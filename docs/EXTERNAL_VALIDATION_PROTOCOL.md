# External validation protocol

This protocol is for retrospective or shadow-mode validation of FableAgent on real-world revenue-cycle data. It is designed to produce evidence that can be reviewed by a customer, diligence team, or independent assessor without treating internally generated results as external validation.

## 1. Pre-register the study before unblinding

Create a signed or otherwise immutable study record before FableAgent outputs are reviewed. Record:

- dataset date range;
- provider group and specialty;
- included payers;
- claim type and transaction versions;
- contract models in scope;
- explicit exclusions;
- minimum sample size;
- reviewer roles and independence;
- definition of an eligible claim line;
- definition of a valid recovery opportunity;
- maturity window for recovered-cash analysis;
- primary metrics and any pass/fail thresholds; and
- the Git commit/container version being evaluated.

Changing scope or thresholds after results are visible creates a new protocol version and must be disclosed.

## 2. Freeze and fingerprint the data

The customer or authorized data custodian produces the validation dataset. Preserve an inventory containing file names or opaque IDs, sizes, control totals, and SHA-256 hashes. Keep the raw source under the agreed security and retention policy.

The evaluation bundle should use opaque claim/finding identifiers whenever possible. Do not add patient names, addresses, member identifiers, dates of birth, or other unnecessary PHI to reviewer metric files.

## 3. Separate model output from ground truth

FableAgent runs against the frozen input without access to historical reviewer labels used as ground truth.

Human reviewers should not be shown FableAgent's aggregate target metrics or pass/fail thresholds while adjudicating individual findings. When practical, use two independent reviewers for a stratified sample and an adjudicator for disagreements.

The customer should select reviewers with relevant revenue-cycle, reimbursement, contracting, denial-management, or coding expertise for the category under review. Corrected claims and modifier changes require qualified coding review.

## 4. Finding-level disposition

Every FableAgent finding must receive one final disposition:

- `true_positive` — payer liability/recovery opportunity is independently supported;
- `false_positive` — the finding is not a valid recovery opportunity;
- `duplicate` — the same economic opportunity was already represented elsewhere;
- `already_recovered` — payment/recovery had already occurred before the evaluation cutoff;
- `excluded` — the case meets a pre-registered exclusion; or
- `unresolved` — evidence is insufficient to adjudicate.

For conservative commercial metrics, `false_positive`, `duplicate`, and `already_recovered` count as invalid findings. An `excluded` case is removed from the primary denominator only when its exclusion reason was defined before unblinding. `unresolved` cases must be reported separately and may not be silently dropped.

For each adjudicated finding retain:

- opaque finding ID;
- payer and category;
- FableAgent predicted recovery amount;
- final disposition;
- independently validated recovery amount;
- reviewer ID/role;
- review timestamp;
- rationale/evidence reference; and
- second-review/adjudication record when applicable.

## 5. Recall requires a complete ground-truth design

Precision can be estimated by reviewing FableAgent findings. Recall cannot.

Do not publish recall unless the customer performs a complete blinded ground-truth sweep over a defined eligible sample and records valid opportunities FableAgent did not flag. Those missed opportunities form the false-negative set.

If the ground-truth sweep is incomplete, report recall as **not estimable** rather than zero, one, or an inferred value.

## 6. Primary metrics

Use a frozen denominator and report both case counts and dollars.

- Precision = true positives / (true positives + invalid findings).
- False discovery rate = invalid findings / adjudicated findings.
- Recall = true positives / (true positives + independently found missed opportunities), only with complete ground truth.
- Coverage = matched-and-priced eligible claim lines / eligible claim lines received.
- Unresolved rate = unresolved FableAgent findings / all FableAgent findings.
- Dollar precision = independently validated true-positive dollars / predicted dollars across adjudicated FableAgent findings.
- Dollar recall = independently validated true-positive dollars / (validated true-positive dollars + validated missed-opportunity dollars), only with complete ground truth.

Publish 95% confidence intervals for count-based precision and recall when sample size permits. Always include raw numerators/denominators next to percentages.

## 7. Required stratification

At minimum, break results down by:

- payer;
- recovery/denial category;
- contract model;
- confidence band;
- dollar band; and
- supported vs manually reviewed workflow.

Small strata must be labeled as low-sample rather than presented as stable performance estimates.

## 8. Economic evidence hierarchy

Use these labels exactly and do not collapse them:

1. **Predicted opportunity** — FableAgent's initial estimate.
2. **Validated opportunity** — customer reviewer confirms payer liability and amount.
3. **Submitted dollars** — validated amount actually pursued.
4. **Accepted/approved dollars** — payer accepts or allows the action.
5. **Recovered dollars** — new cash or credit is observed and reconciled after the action.

Only item 5 is recovered revenue.

## 9. Shadow-mode safety

For the initial external validation:

- keep autonomous outbound submission disabled;
- do not mutate the customer's source claims;
- require human approval before any appeal/correction is sent;
- fail closed on unsupported contract constructs, ambiguous matching, missing reference data, or insufficient documentation; and
- record all overrides and manual decisions.

## 10. Evidence package

Publish an immutable versioned bundle containing:

- pre-registered protocol;
- source inventory/control totals and hashes;
- engine release identifier;
- reference/contract versions and customer approval record;
- complete finding-level review table;
- missed-opportunity table if recall is claimed;
- metric calculation output;
- reviewer/adjudication log;
- submission confirmations when applicable;
- post-action payment reconciliation when recovered revenue is claimed; and
- a limitations/exclusions statement.

Corrections produce a new bundle version. Never overwrite the evidence supporting a previously published result.

## 11. Minimum claim language

Permitted before real-world validation: "technical benchmark," "synthetic regression test," "shadow-pilot candidate."

Permitted after customer adjudication: "X% independently validated precision on the stated retrospective dataset," with sample size, scope, and confidence interval.

Permitted only after payment reconciliation: "$X recovered revenue," with the date range, maturity window, and attribution method.

Do not imply independent validation, clinical validation, payer certification, HIPAA compliance, SOC 2 compliance, or recovered revenue without the corresponding external evidence.
