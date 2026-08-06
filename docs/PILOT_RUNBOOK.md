# First commercial shadow pilot

## Offer

Run a 30–45 day, human-reviewed underpayment and denial discovery pilot for
one professional provider group, one specialty, and two or three high-volume
payers. Start with historical/de-identified data or live PHI only after BAAs
and security onboarding. Do not enable autonomous claim corrections or appeal
submission during the first pilot.

Supported input is complete X12 837P `005010X222A1`, complete 835
`005010X221A1`, or the documented remittance CSV. Institutional 837I, dental,
paper-EOB OCR, arbitrary payer companion-guide exceptions, per-diem, and case
rate contracts are outside this pilot and must not be represented otherwise.

## Customer input package

| Input | Minimum acceptable form | Owner |
|---|---|---|
| Claims | 90–180 days of 837P files or structured API claims | billing/IT |
| Remittances | Corresponding 835 files, including supplements/reversals | billing/IT |
| Contracts | Signed contract plus reviewed structured fee schedule for chosen payers | contracting |
| Payer rules | Timely filing, appeal deadline, portal/address, payer ID mapping | follow-up lead |
| Outcomes | Existing appeal dispositions and post-appeal payments when available | revenue integrity |
| Validation sample | 50–100 adjudicated claim lines stratified by payer and result | customer SME |
| Security | BAA/DPA, access list, retention/deletion approval, secure transfer method | privacy/security |

Patient charts, medical records, and authorizations are needed only for the
specific appeals selected for review. The software never creates clinical
facts or missing documentation.

## Preflight

1. Create the tenant and client; require admin MFA and acknowledge the BAA.
2. Restrict users to named pilot participants and the pilot client.
3. Configure payer IDs/deadlines and leave autopilot disabled.
4. Import/version external references and set the client CMS locality only if
   percent-of-Medicare pricing is in scope.
5. Enter the contract as structured lines, resolve every validation error,
   have the customer contract owner compare a sample to the signed document,
   then activate it. Draft/rejected contracts never price claims.
6. Preview each EDI file. Structural/version errors stop ingestion. Preserve
   the source files and hashes outside FableAgent under the agreed retention
   policy.
7. Run `npm run benchmark:pilot` as a technical smoke test. It is synthetic
   and must never be shown as customer recovery evidence.

## Execution

1. Ingest claims before their remittances; retain job IDs and warnings.
2. Run detection in dry-run mode and reconcile file/claim/line/control totals.
3. Review unmatched lines, unknown patient responsibility, missing contract
   rates, and unknown CARC/RARC before accepting any opportunity.
4. Run committed detection. A customer biller validates every proposed case
   against the contract, original claim, ERA, payer policy, and prior payments.
5. Mark findings true positive, false positive, duplicate, already recovered,
   excluded, or needs more documentation. Do not count “identified dollars” as
   recovered dollars.
6. Generate draft packets only for customer-approved cases. Certified coding
   review is required for every modifier or corrected-claim recommendation.
7. Submit manually through the customer's existing workflow; record the real
   confirmation/tracking reference and later payer decision/payment.

## Evidence and metrics

Use a frozen denominator and publish both counts and dollars:

- Precision = validated true-positive findings / all reviewed findings.
- Coverage = claim lines successfully matched and priced / eligible claim
  lines received.
- False-positive rate = invalid findings / all reviewed findings.
- Identified opportunity = validated payer-liability variance, excluding
  patient responsibility and already-posted supplemental cash.
- Submitted dollars = validated opportunity actually appealed.
- Recovered dollars = new post-appeal cash matched to a submitted case.
- Recovery rate = recovered dollars / submitted dollars with a mature outcome
  window; unresolved cases stay out of the denominator.
- Time saved = customer-measured handling minutes before versus pilot, using
  the same task definition and sample method.

Every case-study figure must name the date range, payers, included/excluded
claim types, sample size, maturity window, and whether it is identified,
submitted, or recovered. Keep screenshots de-identified unless the audience
is authorized for the PHI.

## Go/no-go gate

Advance from shadow mode only after the customer signs off on contract-rate
accuracy, line matching, patient-responsibility handling, supplemental/replay
behavior, access controls, backup/restore, and incident contacts. Keep manual
submission until the actual clearinghouse/payer connector has idempotency,
acknowledgement, rejection, retry, and reconciliation tests in its certified
environment.
