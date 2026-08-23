# Operational acceptance gates

These gates define what FableAgent may represent externally and what may be enabled in a customer environment. Each gate is pass/fail and requires retained evidence tied to an exact release. Repository documentation alone cannot satisfy an external dependency.

## Gate A — controlled shadow-mode release

Required before processing a customer pilot dataset:

- Unit, integration, non-superuser RLS, dependency audit, CodeQL, infrastructure validation, and container-build checks pass on the candidate commit.
- Production secret requirements and HTTPS fail-closed behavior are verified.
- Tenant/client isolation evidence is retained.
- Pilot scope is restricted to supported 837P/835 workflows and explicitly activated contract models.
- Autonomous external submission is disabled.
- Data retention/deletion, named access list, secure transfer method, and incident contacts are documented.
- Required BAAs/agreements are executed before identifiable PHI enters the environment.

**Permitted representation:** technically ready for a controlled, human-reviewed shadow pilot within the documented scope.

**Not permitted:** HIPAA-certified, SOC-certified, independently penetration-tested, production-proven autonomous recovery, or externally validated accuracy unless those separate forms of evidence exist.

## Gate B — publishable retrospective validation

Required before publishing real-world accuracy or opportunity metrics:

- Dataset denominator and inclusion/exclusion rules were frozen before scoring.
- Source inventory and SHA-256 hashes are retained and verify successfully.
- Contract/reference versions are fixed and approved by the customer owner.
- Reviewer dispositions are frozen and attributable to qualified customer or independent RCM personnel.
- Every FableAgent finding is dispositioned; unresolved findings are reported separately rather than silently removed.
- Recall is reported only if the partner performed a complete ground-truth sweep of the eligible denominator.
- Identified, submitted, and recovered dollars are reported separately.
- Precision and other proportions state sample size and confidence intervals.
- Corrections to published evidence create a new immutable version rather than modifying the original bundle.

**Permitted representation:** externally reviewed retrospective performance for the stated population, period, payers, and supported workflow.

**Not permitted:** generalized performance outside the tested population, or recovered-revenue claims without post-action payment evidence.

## Gate C — human-approved production recovery

Required before FableAgent-generated work is actually submitted:

- Gate A and relevant Gate B evidence are complete.
- Customer designates qualified reviewers and approval authority.
- Corrected claims/modifier changes receive qualified coding review.
- Submission occurs through an approved customer/trading-partner workflow and returns a real tracking/reference identifier.
- Idempotency, rejection, retry, acknowledgement, ambiguous-network-failure, and reconciliation behavior are tested in the applicable environment.
- Post-submission 835/payment reconciliation is operational.
- Backup restore has been successfully exercised in the deployed environment against declared RPO/RTO.
- Incident response contacts and escalation have been exercised or tabletop-tested.

**Permitted representation:** used in production with human approval within the validated scope.

## Gate D — autonomous external delivery

This gate is intentionally high. Required before removing human approval from any submission category:

- The exact payer/category/contract workflow has statistically adequate real-world validation and a customer-approved risk threshold.
- The applicable clearinghouse/payer connector has trading-partner certification or equivalent acceptance evidence.
- Duplicate, timeout, retry, rejection, and partial-acknowledgement failure paths have demonstrated safe behavior.
- Customer formally accepts the autonomous scope and exception routing.
- Independent security testing appropriate to the deployment is complete; critical/high findings are remediated or formally accepted by the accountable owner.
- Monitoring can detect and stop abnormal submission or reconciliation behavior.

No repository-only milestone can independently satisfy Gate D.

## Evidence status vocabulary

Use only `pass`, `fail`, `open`, `not_applicable`, or `externally_required` in release records. Every `pass` must identify an artifact, run URL/log, signed record, immutable evidence-bundle path, or other reproducible evidence. Avoid subjective release states such as `mostly complete`.
