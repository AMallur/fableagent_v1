# Order Form — template

> **This template is the commercial half of an agreement whose legal half
> (`master_services_agreement.md`) has not been through attorney review.** Have
> counsel review both before sending either to a customer. This is not legal
> advice.

Every field below maps to something the platform stores and enforces. The
mapping is given for each one so that what is signed and what is configured
cannot drift apart — and so that whoever configures the client afterwards is
transcribing, not interpreting.

---

## Order Form No. `[OF-YYYY-NNN]`

Issued under the Master Services Agreement dated `[DATE]` between
`[PROVIDER LEGAL NAME]` ("Customer") and `[COMPANY LEGAL NAME]` ("Company").

### 1. Customer

| | |
|---|---|
| Legal entity | `[LEGAL NAME]` |
| Group NPI | `[NPI]` → `client.npi_group` |
| Tax ID | `[TIN]` → `client.tax_id` |
| Primary site state | `[ST]` → `client.state` |
| Billing contact | `[NAME, EMAIL]` |
| Technical contact | `[NAME, EMAIL]` |

### 2. Term

| | |
|---|---|
| Effective date | `[DATE]` → `pricing_plan.effective_date` |
| Initial term | `[12] months` |
| Pilot period | `[90] days from the effective date`, during which the Customer operates in shadow mode (§6) |
| Renewal | `[Auto-renews for successive 12-month terms unless either party gives 60 days' notice]` |

### 3. Fees

| Component | Value | Stored as |
|---|---|---|
| Contingency on recovered amounts | `[__]%` | `pricing_plan.contingency_percent` |
| Monthly platform fee | `$[____]` | `pricing_plan.base_fee` |
| Per recovery case opened | `$[____]` | `pricing_plan.per_case_fee` |
| Monthly minimum | `$[____]` | `pricing_plan.minimum_fee` |
| Monthly maximum (cap) | `$[____ or "none"]` | `pricing_plan.maximum_fee` |

Fees are invoiced monthly in arrears. **No fee of any kind is charged during the
pilot period** — the platform refuses to issue an invoice for a Customer in
shadow mode, so this is a property of the system and not only of this document.

### 4. What the contingency is charged on

Select exactly one. This is the single most disputed term in contingency RCM, so
it is stated explicitly rather than left to practice.

- [ ] **Attributed recovery** — payments the platform attributed to an appeal and
      can evidence line by line against the Customer's own remittances.
      → `pricing_plan.contingency_basis = 'attributed'`
- [ ] **Verified recovery only** — as above, but limited to payments a person
      has confirmed. Lower fee base, slower to bill.
      → `pricing_plan.contingency_basis = 'verified'`

### 5. How recovery is measured

Select exactly one basis. The platform blocks go-live if the configured basis
does not match what is recorded here
(`golive.ts` check `attribution_matches_agreement`).

- [ ] **Incremental, net** *(recommended, and the platform default)* — the
      movement in payment after the appeal was submitted, net of anything the
      payer subsequently reversed or recouped.
      → `agreed_attribution_basis = 'incremental_net'`
- [ ] **Gross post-appeal** — every dollar paid after submission. This
      over-credits a reverse-and-reissue by construction: where a payer voids a
      claim and re-pays it, the re-payment is counted in full even though the
      Customer already held that money.
      → `agreed_attribution_basis = 'gross_post_appeal'`

Modifiers to the measurement:

| Term | Value | Stored as |
|---|---|---|
| Attribution window — payment arriving more than this many days after submission is not attributed | `[__ days / none]` | `client.attribution_window_days` |
| Minimum attributable movement | `$[____]` | `client.attribution_min_amount` |
| Payments the payer did not resolve to a specific service line | `[ ] attributed  [ ] excluded` | `client.attribution_include_unallocated` |
| Payer takeback after a credited recovery | `[ ] reversed automatically  [ ] flagged for review` | `client.clawback_policy` |

The window is measured against the payer's **check date**, not the date the
remittance file reached the platform, so a backfill of historical remittances
cannot defeat it.

### 6. Operating mode

The Customer begins in **shadow mode**: the platform ingests, detects, prices and
prepares appeal packets, and transmits nothing to any payer. Nothing is billed.

Moving to live operation requires all of:

1. A go-live preflight with zero blocking failures
   (`node src/cli.ts preflight --client <id>`);
2. Customer's written confirmation, after reviewing the shadow-period findings;
3. Company's countersignature below.

Either party may return the Customer to shadow mode at any time, immediately and
without cause. The platform does not require a preflight to stop.

| | |
|---|---|
| Go-live authorised on | `[DATE]` |
| Preflight evidence reference | `[go_live_check id]` → `client.go_live_evidence` |

### 7. Appeal submission authority

- [ ] **Company prepares only.** Every packet is submitted by Customer staff.
- [ ] **Company may submit electronically** for payers listed at Schedule A,
      where the packet is not flagged for review and confidence meets the
      configured threshold. → `client_payer_config.autopilot_enabled`

Submission authority has no effect while the Customer is in shadow mode.

### 8. Invoicing and evidence

Each invoice is accompanied by a statement listing every payment it charges
against: claim number, payer, check date, amount recovered and the fee derived
from it. A negative line is money a payer took back after it had been credited,
and reduces the invoice.

On request, and at no charge, the Company will provide an evidence pack for any
period: the underlying append-only ledger, the invoices, the configuration in
force and the audit trail, under a content hash the Customer can independently
recompute.

Payment terms: `[net 30]` from invoice date. Disputed lines may be withheld
pending resolution; undisputed lines remain due.

### 9. Signatures

| Customer | Company |
|---|---|
| Name: `________________` | Name: `________________` |
| Title: `________________` | Title: `________________` |
| Date: `________________` | Date: `________________` |

---

## Configuration checklist (internal — not part of the executed document)

After countersignature, before the Customer processes anything:

1. Create the `pricing_plan` row with the fee fields from §3, the basis from §4,
   and `agreement_reference` set to this order form's number. **An invoice cannot
   be issued without that reference.**
2. Set `agreed_attribution_basis` from §5 and the matching `client.*` attribution
   fields.
3. Record the BAA acknowledgement.
4. Load and approve contracts; configure and validate payers.
5. Run `preflight` and resolve every blocking item.
6. Leave the Customer in shadow mode until §6 is satisfied.
