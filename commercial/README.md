# Commercial package

The customer-facing commercial layer: what a clinic, a health system's vendor-risk
team, or a payer is actually sent, and how each document connects to something the
platform enforces rather than merely asserts.

This directory deliberately does **not** repeat the compliance program
(`compliance/`) or the internal operational documentation (`docs/`). Those cover
HIPAA obligations and how the system is run. These cover the commercial
relationship: what is promised, on what terms, and how the promise is evidenced.

## Contents

| File | Who receives it | Status |
|---|---|---|
| `master_services_agreement.md` | Customer's counsel | **Attorney review required before use** |
| `order_form_template.md` | Customer signatory | Template — fields map 1:1 to `pricing_plan` |
| `service_level_agreement.md` | Customer operations / procurement | Drafted; commitments must be confirmed against the deployed topology |
| `support_policy.md` | Customer operations | Drafted, ready to adopt |
| `security_questionnaire.md` | Vendor-risk / IT security review | Answers verified against the code as cited |
| `pilot_protocol.md` | Design partner | Ready to run |

## What is enforced, not just written

The commercial documents in this directory are wired to platform behavior. This
is the part worth checking before a negotiation, because it constrains what can
honestly be agreed to:

| Commercial term | Where it is enforced |
|---|---|
| Contingency percentage, base and per-case fees, floor and cap | `pricing_plan`; applied in `engine/src/web/billing.ts` |
| The executed agreement behind the fee | `pricing_plan.agreement_reference` — **an invoice cannot be issued without it** (`issueInvoice`) |
| Which post-appeal dollars count as recovery | `client.attribution_basis` and the window, floor and unallocated switches; applied in `reconcilePaymentsInner` |
| The basis the customer agreed to matching the basis applied | Blocking check `attribution_matches_agreement` in `engine/src/integration/golive.ts` |
| Pilot posture — prepare but never transmit or bill | `client.operating_mode`; enforced via `app.client_is_live()` in the appeal path and at invoice issue |
| Each recovery billed exactly once | `usage_event` append-only ledger; unique index on `payment_event_id`; one invoice may hold a row |
| An issued invoice does not change | Database trigger `app.protect_issued_invoice()`; corrections are void and reissue |
| Evidence a customer or auditor can verify | `buildEvidencePack` / `evidencePackHash` in `engine/src/web/statement.ts` |

Run `node src/cli.ts preflight --client <id>` before signing anything that assumes
the platform is ready for a given client. It exits non-zero when a blocking
prerequisite is missing and names the remedy for each.

## What none of this establishes

Stated plainly, because a commercial package that overstates its position is
worse than none:

- **No recovery has been validated against a real payer.** Every performance
  figure in the repository is synthetic or derived from CMS aggregate data with
  synthetic perturbations. `docs/FABLEAGENT_PUBLIC_DATA_POC.md` and the POC output
  list "actual historical payer underpayments" and "recovered cash" as *not
  demonstrated*. Do not quote a recovery rate to a prospect.
- **No third-party attestation exists.** No SOC 2, no HITRUST, no penetration test
  report. `security_questionnaire.md` answers from the code and says so where an
  attestation would normally be cited.
- **No clearinghouse production certification.** The Optum connector is verified
  against the sandbox only.
- **These documents are drafts, not executed agreements**, and the MSA in
  particular requires attorney review before it is sent to anyone.
