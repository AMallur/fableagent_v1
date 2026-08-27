# Shadow-mode pilot protocol

How a first engagement is actually run: what happens, in what order, what is
measured, and what has to be true before any money changes hands.

This is the protocol the platform enforces — `client.operating_mode` is a real
column, shadow mode really does prevent transmission and invoicing, and the
go-live gate really does refuse. It is not an aspiration document.

## Why shadow first

A recovery platform's claim is that it finds money the provider's own billers
missed. That claim is testable, and the only honest way to test it is to run
both in parallel on the same remittances and compare. Everything else is a
demonstration.

Shadow mode also removes the two risks a provider actually worries about in
week one: that something incorrect is transmitted to a payer under their NPI,
and that they are billed for recoveries they would have captured anyway.
Neither is possible while the client is in shadow.

## Phase 0 — Before any PHI moves

| Step | Done when |
|---|---|
| BAA executed and acknowledgement recorded | `client.baa_acknowledged_at` is set; client creation refuses without it |
| MSA and order form countersigned | Order form number recorded on the pricing plan |
| Attribution basis agreed **in writing** | `pricing_plan.agreed_attribution_basis` matches `client.attribution_basis` |
| Contracts loaded and approved | At least one active, approved, unexpired contract |
| Payers configured and validated | At least one payer cleared for detection |
| Client confirmed in shadow | `operating_mode = 'shadow'` (the default for a new client) |

Run `node src/cli.ts preflight --client <id>`. Phase 0 is complete when the only
remaining failures are ones you have consciously accepted as warnings.

## Phase 1 — Parallel run (60–90 days)

The platform ingests real 837s and 835s and produces findings. Nothing is
transmitted. Nothing is billed.

**What the provider does:** keeps working their denials exactly as they do
today, changing nothing. This matters — a pilot where the provider changes
behaviour measures the platform against a moving baseline and proves nothing.

**What is compared, weekly:**

| Measure | Source |
|---|---|
| Cases the platform opened that the biller had not | Recovery case list vs the provider's worklist |
| Cases the biller worked that the platform missed | The provider's outcomes vs platform findings |
| Findings the biller reviewed and rejected as wrong | Case disposition, with the reason captured |
| Dollar value of each of the above | `recovery_opportunity` on the case |

The third row is the one that matters most and is the one most often skipped.
A platform that surfaces twice as many cases but is wrong a third of the time
costs the provider more than it returns. Capture the rejections and the reason,
every week, or the pilot has not measured anything.

**Reference data:** import the current quarterly CMS NCCI PTP files before the
parallel run begins. Without them the platform declines to conclude anything
about bundling denials — correct behaviour, but it means a whole denial category
falls back to manual review and the comparison is not representative.

## Phase 2 — Read-out

Produce, from the platform rather than from a spreadsheet:

- An evidence pack covering the full pilot period
  (`GET /api/admin/clients/:id/evidence-pack`), which carries the ledger, the
  configuration that was in force, and the audit trail under a verifiable hash.
- A statement preview for one representative month, so the provider sees exactly
  what an invoice and its backing detail will look like before agreeing to
  receive one.

Decide against the numbers actually observed:

| Outcome | Action |
|---|---|
| Net new recovery clearly exceeds the fee, rejections low | Proceed to Phase 3 |
| Net new recovery marginal | Extend, or narrow to the payers and denial categories that performed |
| Rejection rate high | Do not go live. Fix detection first; going live converts a precision problem into a payer-relations problem |

## Phase 3 — Go live

1. Re-run the preflight. Every blocking check must pass; it will refuse
   otherwise, and that refusal is recorded.
2. Obtain the provider's written confirmation referencing the read-out.
3. Move the client to live (`POST /api/admin/clients/:id/operating-mode`). The
   approval, the approver and the preflight it relied on are recorded on the
   client and in `go_live_check`.
4. Decide submission authority per payer — prepare-only is a valid steady state
   and a reasonable place to stay for the first quarter of live operation.

Billing begins with the first full month after go-live. The pilot period is
never billed.

## Returning to shadow

At any time, by either party, immediately, without cause and without a
preflight. Stopping must never be harder than starting. In-flight appeals
already transmitted are unaffected; nothing further is sent.

## What a pilot cannot establish

- **Payer response.** Shadow mode transmits nothing, so appeal win rates are not
  measured. The first live quarter measures that, and it should be expected to
  differ from the platform's predicted appealability scores.
- **Anything about payers not in the data.** Findings generalise across payers
  far less than people expect.
- **Long-run recovery.** A 90-day window sees the front of the appeal lifecycle,
  not its conclusion.

Say all three out loud at the read-out. A pilot oversold is a renewal lost.
